// kyc.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const authenticate = require('./authMiddleware');
const User = require('./user');

const uploadDir = path.join(__dirname, '../uploads/kyc/');
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log(`✅ Created upload directory: ${uploadDir}`);
  } else {
    console.log(`✅ Upload directory exists: ${uploadDir}`);
  }
} catch (err) {
   console.error(`❌ Failed to create upload directory ${uploadDir}:`, err);
   // Exit or handle critically if upload directory cannot be created
   // process.exit(1);
}


const storage = multer.diskStorage({
  destination: function (req, file, cb) {
     if (!fs.existsSync(uploadDir)) {
        return cb(new Error('KYC upload directory not found or inaccessible.'), null);
     }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const uniqueSuffix = `${req.userId}-${file.fieldname}-${Date.now()}${path.extname(sanitizedFilename)}`;
    cb(null, uniqueSuffix);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'application/pdf'];
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPG, PNG, and PDF files are allowed!'), false);
  }
};

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: fileFilter,
});

router.post('/kyc/upload', authenticate, upload.fields([
  { name: 'id_front', maxCount: 1 },
  { name: 'id_back', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
  { name: 'address_proof', maxCount: 1 },
]), async (req, res) => {
  let uploadedFiles = [];
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
       if (req.files) {
            for (const field in req.files) {
                const file = req.files[field][0];
                uploadedFiles.push(file.path);
            }
       }
      return res.status(400).json({ error: 'At least one document is required.' });
    }

     if (req.files) {
        for (const field in req.files) {
            const file = req.files[field][0];
            uploadedFiles.push(file.path);
        }
     }

    const user = await User.findById(req.userId).select('kycStatus kycDocuments');
    if (!user) {
       uploadedFiles.forEach(filePath => fs.unlink(filePath, (err) => { if (err) console.error(`Error cleaning up file ${filePath}:`, err); }));
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.kycStatus === 'pending' || user.kycStatus === 'approved') {
        uploadedFiles.forEach(filePath => fs.unlink(filePath, (err) => { if (err) console.error(`Error cleaning up file ${filePath}:`, err); }));
         return res.status(400).json({ error: `KYC is already ${user.kycStatus}.` });
    }

     if (user.kycStatus === 'rejected') {
        user.kycDocuments.forEach(doc => {
            fs.unlink(doc.path, (err) => {
                 if (err) console.error(`Error deleting old KYC file ${doc.path}:`, err);
            });
        });
     }

    user.kycDocuments = [];

    for (const field in req.files) {
      const file = req.files[field][0];
      user.kycDocuments.push({
        path: file.path,
        filename: file.filename,
        documentType: file.fieldname,
        uploadDate: new Date(),
      });
    }

    user.kycStatus = 'pending';
    await user.save();

    res.json({
      message: '✅ KYC documents uploaded successfully. They are now pending review.',
      kycStatus: user.kycStatus,
    });
  } catch (err) {
    console.error('KYC upload error:', err);
     uploadedFiles.forEach(filePath => fs.unlink(filePath, (err) => { if (err) console.error(`Error cleaning up file ${filePath}:`, err); }));

    if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: `Upload failed: ${err.message}` });
    }
     if (err.message.includes('allowed!')) {
        return res.status(400).json({ error: `Upload failed: ${err.message}` });
    }

    res.status(500).json({ error: 'Internal server error during file upload.' });
  }
});

module.exports = router;