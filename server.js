// Load environment variables securely
require('dotenv').config();

// Validate required environment variables
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('Missing required environment variables. Please check .env file.');
    process.exit(1);
}

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize Supabase client with error handling
let supabase;
try {
    supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_ANON_KEY
    );
} catch (error) {
    console.error('Failed to initialize Supabase client:', error);
    process.exit(1);
}

// Store visitor counts per site
const visitors = new Map();
const sites = new Set();

// Store WebSocket connections for each site
const connections = new Map();

// Add CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Update paths to be Glitch-friendly
app.use(express.static('src'));

// Serve the dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'dashboard.html'));
});

app.get('/testing', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'test.html'));
});

// Create new site
app.post('/new-site', async (req, res) => {
    const siteId = crypto.randomBytes(8).toString('hex');
    const { data, error } = await supabase
        .from('sites')
        .insert([{ 
            site_id: siteId, 
            total_visitors: 0,
            unique_visitors: 0
        }]);
    
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json({ siteId });
});

// Get all sites
app.get('/sites', async (req, res) => {
    const { data, error } = await supabase
        .from('sites')
        .select('site_id');
    
    if (error) {
        res.status(500).json({ error: error.message });
        return;
    }
    res.json(data.map(site => site.site_id));
});

// Get visitor counts for all sites
app.get('/visitors', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('sites')
            .select('site_id, total_visitors, unique_visitors');
        
        if (error) throw error;
        
        if (!data || data.length === 0) {
            res.json({});
            return;
        }

        const counts = {};
        data.forEach(site => {
            counts[site.site_id] = {
                total: site.total_visitors || 0,
                unique: site.unique_visitors || 0
            };
        });
        
        res.json(counts);
    } catch (error) {
        console.error('Error fetching visitors:', error);
        res.status(500).json({ error: error.message });
    }
});

// New endpoint to get country statistics
app.get('/country-stats/:siteId', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('visitor_logs')
            .select('country, client_id, visit_count')
            .eq('site_id', req.params.siteId);
        
        if (error) throw error;

        const countryStats = {};
        data.forEach(log => {
            if (!countryStats[log.country]) {
                countryStats[log.country] = {
                    total: 0,
                    unique: new Set()
                };
            }
            countryStats[log.country].total += (log.visit_count || 0);
            countryStats[log.country].unique.add(log.client_id);
        });

        // Convert Sets to counts
        Object.keys(countryStats).forEach(country => {
            countryStats[country].unique = countryStats[country].unique.size;
        });

        res.json(countryStats);
    } catch (error) {
        console.error('Error fetching country stats:', error);
        res.status(500).json({ error: error.message });
    }
});

// Serve the SVG world map
app.get('/worldmap.svg', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'worldmap.svg'));
});

// Update the map endpoint to serve the world map
app.get('/world.svg', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'world.svg'));
});

// Remove the simplemap endpoint since we're not using it anymore
// app.get('/simplemap.svg', ...)

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    // Extract siteId from URL params
    const siteId = new URL(req.url, 'http://localhost').searchParams.get('siteId');
    
    if (siteId) {
        if (!connections.has(siteId)) {
            connections.set(siteId, new Set());
        }
        connections.get(siteId).add(ws);
    }

    ws.on('close', () => {
        if (siteId && connections.has(siteId)) {
            connections.get(siteId).delete(ws);
        }
    });
});

// Track visitors per site
app.get('/track', async (req, res) => {
    const { siteId, clientId, country } = req.query;
    
    try {
        if (!siteId || !clientId || !country) {
            throw new Error('Missing required parameters');
        }

        console.log(`New visit from ${country} for site ${siteId}`);

        // First get existing visit count if any
        const { data: existingVisits, error: visitError } = await supabase
            .from('visitor_logs')
            .select('visit_count, country')
            .eq('site_id', siteId)
            .eq('client_id', clientId)
            .single();

        if (visitError && visitError.code !== 'PGRST116') { // Ignore "no rows returned" error
            throw visitError;
        }

        const newVisitCount = (existingVisits?.visit_count || 0) + 1;
        console.log(`Visit count for client ${clientId}: ${newVisitCount}`);

        // Update visitor log with incremented visit count
        const { error: logError } = await supabase
            .from('visitor_logs')
            .upsert([{
                site_id: siteId,
                client_id: clientId,
                country: country,
                last_visit: new Date(),
                visit_count: newVisitCount
            }], {
                onConflict: 'site_id,client_id'
            });

        if (logError) {
            console.error('Error updating visitor log:', logError);
            throw logError;
        }

        // Get total visits and unique visitors with fresh data
        const { data: stats, error: statsError } = await supabase
            .from('visitor_logs')
            .select('client_id, visit_count, country')
            .eq('site_id', siteId);

        if (statsError) {
            console.error('Error fetching visitor stats:', statsError);
            throw statsError;
        }

        // Calculate totals including visit_count
        const totalVisits = stats.reduce((sum, log) => sum + (log.visit_count || 0), 0);
        const uniqueVisitors = new Set(stats.map(s => s.client_id)).size;

        console.log(`Total visits: ${totalVisits}, Unique visitors: ${uniqueVisitors}`);

        // Update site stats in database
        const { error: updateError } = await supabase
            .from('sites')
            .update({
                total_visitors: totalVisits,
                unique_visitors: uniqueVisitors
            })
            .eq('site_id', siteId);

        if (updateError) {
            console.error('Error updating site stats:', updateError);
            throw updateError;
        }

        // Calculate country stats for real-time update
        const countryStats = {};
        stats.forEach(log => {
            if (!countryStats[log.country]) {
                countryStats[log.country] = {
                    total: 0,
                    unique: new Set()
                };
            }
            countryStats[log.country].total += (log.visit_count || 0);
            countryStats[log.country].unique.add(log.client_id);
        });

        // Convert Sets to counts for JSON
        Object.keys(countryStats).forEach(countryCode => {
            countryStats[countryCode].unique = countryStats[countryCode].unique.size;
        });

        console.log(`Country stats for ${country}:`, countryStats[country]);

        // Broadcast update with country stats
        if (connections.has(siteId)) {
            const updateData = JSON.stringify({
                type: 'update',
                stats: {
                    total: totalVisits,
                    unique: uniqueVisitors,
                    country: country,
                    countryStats: countryStats
                }
            });
            connections.get(siteId).forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(updateData);
                }
            });
        }

        res.json({ 
            success: true, 
            stats: { 
                total: totalVisits, 
                unique: uniqueVisitors,
                countryStats: countryStats
            } 
        });

    } catch (error) {
        console.error('Error tracking visitor:', error);
        res.status(500).json({ 
            error: error.message,
            details: 'Failed to track visitor'
        });
    }
});

// Update the tracker script with more reliable IP geolocation 
app.get('/tracker.js', (req, res) => {
    const siteId = req.query.siteId;
    const host = process.env.PROJECT_DOMAIN ? 
        `https://${process.env.PROJECT_DOMAIN}.glitch.me` : 
        `${req.protocol}://${req.get('host')}`;
        
    res.type('application/javascript');
    res.send(`
        async function getCountry() {
            try {
                // Try ipapi.co first with better error handling
                try {
                    const response = await fetch('https://ipapi.co/json/', {
                        headers: { 
                            'Accept': 'application/json',
                            'User-Agent': 'Mozilla/5.0' 
                        },
                        timeout: 5000
                    });
                    
                    if (response.ok) {
                        const data = await response.json();
                        if (data.country_code) {
                            console.log('Country detected via ipapi.co:', data.country_code);
                            return data.country_code;
                        }
                    }
                } catch (e) {
                    console.warn('ipapi.co failed:', e);
                }

                // Try ip-api.com with HTTPS
                try {
                    const backupResponse = await fetch('https://api.ipapi.com/check?access_key=YOUR_ACCESS_KEY', {
                        timeout: 5000
                    });
                    
                    if (backupResponse.ok) {
                        const backupData = await backupResponse.json();
                        if (backupData.country_code) {
                            console.log('Country detected via ip-api:', backupData.country_code);
                            return backupData.country_code;
                        }
                    }
                } catch (e) {
                    console.warn('ip-api.com failed:', e);
                }

                // Try Cloudflare's geo detection
                try {
                    const geoResponse = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
                    if (geoResponse.ok) {
                        const text = await geoResponse.text();
                        const loc = text.split('\\n').find(line => line.startsWith('loc='));
                        if (loc) {
                            const country = loc.split('=')[1];
                            console.log('Country detected via Cloudflare:', country);
                            return country;
                        }
                    }
                } catch (e) {
                    console.warn('Cloudflare detection failed:', e);
                }

                // Final fallback using ipinfo.io
                try {
                    const ipinfoResponse = await fetch('https://ipinfo.io/json', {
                        headers: { 'Accept': 'application/json' },
                        timeout: 5000
                    });
                    
                    if (ipinfoResponse.ok) {
                        const ipinfoData = await ipinfoResponse.json();
                        if (ipinfoData.country) {
                            console.log('Country detected via ipinfo.io:', ipinfoData.country);
                            return ipinfoData.country;
                        }
                    }
                } catch (e) {
                    console.warn('ipinfo.io failed:', e);
                }

                throw new Error('All geolocation services failed');
            } catch (error) {
                console.error('Error getting country:', error);
                return 'XX';
            }
        }

        let isTracking = false;
        async function trackVisit() {
            if (isTracking) return;
            isTracking = true;

            try {
                let clientId = localStorage.getItem('analytics_client_id');
                if (!clientId) {
                    clientId = Math.random().toString(36).substring(2) + Date.now().toString(36);
                    localStorage.setItem('analytics_client_id', clientId);
                }

                const country = await getCountry();
                if (country === 'XX') {
                    console.warn('Could not determine country accurately');
                } else {
                    console.log('Successfully detected country:', country);
                }

                const response = await fetch('${host}/track?siteId=${siteId}&clientId=' + clientId + '&country=' + country, {
                    mode: 'cors',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });

                if (!response.ok) {
                    throw new Error('Tracking request failed');
                }

                const result = await response.json();
                console.log('Tracking successful:', result);
            } catch (error) {
                console.error('Error tracking visit:', error);
            } finally {
                isTracking = false;
            }
        }

        // Track initial visit
        trackVisit();

        // Track when tab becomes visible again
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                trackVisit();
            }
        });
    `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
