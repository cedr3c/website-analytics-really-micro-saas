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

app.get('/dev/testing', (req, res) => {
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
        // Get fresh data from visitor_logs
        const { data, error } = await supabase
            .from('visitor_logs')
            .select('country, client_id, site_id')
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
            countryStats[log.country].total++;
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

// Track visitors per site
app.get('/track', async (req, res) => {
    const { siteId, clientId, country } = req.query;
    
    try {
        // Input validation
        if (!siteId || !clientId || !country) {
            throw new Error('Missing required parameters');
        }

        // Call the increment_visitors function and handle the response properly
        const { data, error } = await supabase.rpc('increment_visitors', {
            p_site_id: siteId,
            p_client_id: clientId,
            p_country: country
        });

        if (error) {
            console.error('Supabase RPC error:', error);
            throw error;
        }

        // Force refresh the stats cache
        await supabase.from('sites')
            .select('total_visitors')
            .eq('site_id', siteId)
            .single();

        console.log(`Successfully tracked visit from ${country} for site ${siteId}`);
        res.json({ success: true });

    } catch (error) {
        console.error('Error tracking visitor:', error);
        res.status(500).json({ 
            error: error.message,
            details: 'Failed to track visitor'
        });
    }
});

// Update the tracker script to use correct protocol and host
app.get('/tracker.js', (req, res) => {
    const siteId = req.query.siteId;
    const host = process.env.PROJECT_DOMAIN ? 
        `https://${process.env.PROJECT_DOMAIN}.glitch.me` : 
        `${req.protocol}://${req.get('host')}`;
        
    res.type('application/javascript');
    res.send(`
        async function getCountry() {
            try {
                const response = await fetch('https://ipapi.co/json/');
                const data = await response.json();
                return data.country_code;
            } catch (error) {
                console.error('Error getting country:', error);
                return 'UNKNOWN';
            }
        }

        async function trackVisit() {
            let clientId = localStorage.getItem('analytics_client_id');
            if (!clientId) {
                clientId = Math.random().toString(36).substring(2) + Date.now().toString(36);
                localStorage.setItem('analytics_client_id', clientId);
            }

            const country = await getCountry();

            fetch('${host}/track?siteId=${siteId}&clientId=' + clientId + '&country=' + country, {
                mode: 'cors',
                headers: {
                    'Content-Type': 'application/json'
                }
            })
            .catch(console.error);
        }

        trackVisit();
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
