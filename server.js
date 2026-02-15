const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    // Allow all origins for now (you can restrict later)
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Handle preflight requests
app.options('*', cors());


app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`📨 ${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// MongoDB connection
let db;
let specimensCollection;

const connectDB = async () => {
  try {
    const client = await MongoClient.connect(process.env.MONGODB_URI);
    
    // Use the database name from env or default to 'RocksDB'
    const dbName = process.env.DB_NAME || 'RocksDB';
    db = client.db(dbName);
    
    // Access the specimens collection
    specimensCollection = db.collection('specimens');
    
    console.log(`✅ Connected to MongoDB - Database: ${dbName}, Collection: specimens`);
    
    // Verify connection by counting documents
    const count = await specimensCollection.countDocuments();
    console.log(`📊 Found ${count} specimens in collection`);
    
    // List all collections to help debug
    const collections = await db.listCollections().toArray();
    console.log(`📚 Available collections:`, collections.map(c => c.name).join(', '));
    
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Geological Specimens API is running',
    timestamp: new Date().toISOString()
  });
});

// Database stats endpoint for debugging
app.get('/api/debug/stats', async (req, res) => {
  try {
    const count = await specimensCollection.countDocuments();
    const sample = await specimensCollection.findOne();
    
    res.json({
      success: true,
      stats: {
        totalDocuments: count,
        collectionName: specimensCollection.collectionName,
        databaseName: db.databaseName,
        sampleDocument: sample ? {
          hasId: !!sample._id,
          hasName: !!sample.name,
          hasImageLink: !!sample.imageLink,
          fields: Object.keys(sample)
        } : null
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET all specimens (with optional pagination and search)
app.get('/api/specimens', async (req, res) => {
  try {
    console.log('📥 GET /api/specimens - Request received');
    console.log('Query params:', req.query);
    
    const { 
      page = 1, 
      limit = 50, 
      search = '', 
      mineral = '',
      location = '',
      color = '',
      fluorescence = ''
    } = req.query;

    // Build query filter
    const filter = {};
    console.log('Building filter...');
    
    // Text search across name, description, and searchTags
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { searchTags: { $regex: search, $options: 'i' } },
        { minerals: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } },
        { colors: { $regex: search, $options: 'i' } },
        { fluorescence: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Category filters (arrays use $in or $elemMatch)
    if (mineral) {
      filter.minerals = { $regex: mineral, $options: 'i' };
    }
    
    if (location) {
      filter.location = { $regex: location, $options: 'i' };
    }
    
    if (color) {
      filter.colors = { $regex: color, $options: 'i' };
    }
    
    if (fluorescence) {
      switch (fluorescence) {
        case 'all_fluorescent':
          // Any fluorescence except "None" or null
          filter.fluorescence = { 
            $exists: true, 
            $ne: null,
            $not: { $in: ['None', 'none', ''] }
          };
          break;
        
        case 'shortwave':
          // Contains (SW)
          filter.fluorescence = { $regex: '\\(SW\\)', $options: 'i' };
          break;
        
        case 'midwave':
          // Contains (MW)
          filter.fluorescence = { $regex: '\\(MW\\)', $options: 'i' };
          break;
        
        case 'longwave':
          // Contains (LW)
          filter.fluorescence = { $regex: '\\(LW\\)', $options: 'i' };
          break;
        
        case 'non_fluorescent':
          // Fluorescence is "None", null, or empty
          filter.$or = [
            { fluorescence: { $in: ['None', 'none', ''] } },
            { fluorescence: { $exists: false } },
            { fluorescence: null }
          ];
          break;
        
        default:
          // Fallback to original behavior
          filter.fluorescence = { $regex: fluorescence, $options: 'i' };
      }
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    console.log('Filter:', JSON.stringify(filter));
    console.log('Pagination: page', page, 'limit', limit, 'skip', skip);
    
    // Execute query with sorting by dateAdded (newest first)
    console.log('Querying database...');
    
    // Try with sort first, fall back to no sort if it fails
    let specimens;
    try {
      specimens = await specimensCollection
        .find(filter)
        .sort({ dateAdded: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .toArray();
    } catch (sortError) {
      console.warn('⚠️ Sort failed, trying without sort:', sortError.message);
      specimens = await specimensCollection
        .find(filter)
        .skip(skip)
        .limit(parseInt(limit))
        .toArray();
    }
    
    console.log(`Found ${specimens.length} specimens`);
    
    // Get total count for pagination
    const total = await specimensCollection.countDocuments(filter);
    console.log(`Total count: ${total}`);
    
    // Process imageLink array - no S3 URL generation needed since links are already stored
    const processedSpecimens = specimens.map(specimen => ({
      ...specimen,
      // Ensure imageLink is always an array
      imageLink: Array.isArray(specimen.imageLink) ? specimen.imageLink : [specimen.imageLink].filter(Boolean),
      // Add a primary image for convenience
      primaryImage: Array.isArray(specimen.imageLink) && specimen.imageLink.length > 0 
        ? specimen.imageLink[0] 
        : null
    }));

    res.json({
      success: true,
      data: processedSpecimens,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
    
    console.log('✅ Response sent successfully');
  } catch (error) {
    console.error('❌ Error fetching specimens:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch specimens',
      message: error.message 
    });
  }
});

// GET single specimen by ID
app.get('/api/specimens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ObjectId
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid specimen ID' 
      });
    }

    const specimen = await specimensCollection.findOne({ 
      _id: new ObjectId(id) 
    });

    if (!specimen) {
      return res.status(404).json({ 
        success: false, 
        error: 'Specimen not found' 
      });
    }

    // Process imageLink array
    const processedSpecimen = {
      ...specimen,
      imageLink: Array.isArray(specimen.imageLink) ? specimen.imageLink : [specimen.imageLink].filter(Boolean),
      primaryImage: Array.isArray(specimen.imageLink) && specimen.imageLink.length > 0 
        ? specimen.imageLink[0] 
        : null
    };

    res.json({
      success: true,
      data: processedSpecimen
    });
  } catch (error) {
    console.error('Error fetching specimen:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch specimen',
      message: error.message 
    });
  }
});

// GET available filter categories
app.get('/api/categories', async (req, res) => {
  try {
    // Get distinct values for filter fields
    // For array fields, we need to unwind them first
    const mineralsAgg = await specimensCollection.aggregate([
      { $unwind: '$minerals' },
      { $group: { _id: '$minerals' } },
      { $sort: { _id: 1 } }
    ]).toArray();
    
    const colorsAgg = await specimensCollection.aggregate([
      { $unwind: '$colors' },
      { $group: { _id: '$colors' } },
      { $sort: { _id: 1 } }
    ]).toArray();
    
    const fluorescenceAgg = await specimensCollection.aggregate([
      { $unwind: '$fluorescence' },
      { $group: { _id: '$fluorescence' } },
      { $sort: { _id: 1 } }
    ]).toArray();

    const locations = await specimensCollection.distinct('location');

    res.json({
      success: true,
      data: {
        minerals: mineralsAgg.map(m => m._id).filter(Boolean),
        colors: colorsAgg.map(c => c._id).filter(Boolean),
        fluorescence: fluorescenceAgg.map(f => f._id).filter(Boolean),
        locations: locations.filter(Boolean).sort()
      }
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch categories',
      message: error.message 
    });
  }
});

// GET search suggestions (autocomplete)
app.get('/api/search/suggestions', async (req, res) => {
  try {
    const { q = '' } = req.query;
    
    if (!q || q.length < 2) {
      return res.json({ success: true, data: [] });
    }

    const suggestions = await specimensCollection
      .find({
        $or: [
          { name: { $regex: q, $options: 'i' } },
          { searchTags: { $regex: q, $options: 'i' } }
        ]
      })
      .project({ name: 1, _id: 1, minerals: 1 })
      .limit(10)
      .toArray();

    res.json({
      success: true,
      data: suggestions.map(s => ({ 
        id: s._id, 
        name: s.name,
        minerals: s.minerals || []
      }))
    });
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch suggestions',
      message: error.message 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Route not found' 
  });
});

// Start server
const startServer = async () => {
  try {
    console.log('🚀 Starting server...');
    console.log(`📍 Port: ${PORT}`);
    console.log(`📍 MongoDB URI: ${process.env.MONGODB_URI || 'NOT SET'}`);
    console.log(`📍 Database: ${process.env.DB_NAME || 'RocksDB (default)'}`);
    
    await connectDB();
    
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`📍 API available at http://localhost:${PORT}/api`);
      console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
      console.log(`📍 Debug stats: http://localhost:${PORT}/api/debug/stats`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();