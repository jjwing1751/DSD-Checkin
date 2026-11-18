const multer = require('multer');

const IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const DOCS = [...IMAGE, 'application/pdf'];

function make(allowed, maxFiles = 4) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: maxFiles, fields: 60 },
    fileFilter: (req, file, cb) => {
      if (allowed.includes(file.mimetype)) return cb(null, true);
      const e = new Error('Upload a photo (JPEG, PNG, HEIC) or PDF.');
      e.status = 400; e.expose = true;
      cb(e);
    },
  });
}

module.exports = { images: make(IMAGE), docs: make(DOCS, 1) };
