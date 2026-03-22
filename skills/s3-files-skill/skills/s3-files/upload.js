#!/usr/bin/env node
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const { generateDownloadUrl } = require('./download-url.js');

const s3Client = new S3Client({ region: config.region });
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

function sanitizeS3Key(key) {
  if (!key) return null;
  
  // パストラバーサルの試みと無効な文字を除去
  let sanitized = key
    .replace(/\.\./g, '')
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  
  // 長さを制限
  if (sanitized.length > 1024) {
    sanitized = sanitized.substring(0, 1024);
  }
  
  // uploads ディレクトリ内であることを確認
  if (!sanitized.startsWith('uploads/')) {
    sanitized = `uploads/${sanitized}`;
  }
  
  return sanitized;
}

async function uploadFile(filePath, s3Key) {
  if (!fs.existsSync(filePath)) {
    console.error('❌ File not found');
    throw new Error('File not found');
  }

  // 読み込み前にファイルサイズを確認
  const stats = fs.statSync(filePath);
  if (stats.size > MAX_FILE_SIZE) {
    console.error('❌ File too large (max 100MB)');
    throw new Error('File exceeds maximum size');
  }

  const fileContent = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  
  // S3 キーをサニタイズ
  const key = sanitizeS3Key(s3Key) || `uploads/${Date.now()}-${fileName}`;

  console.log(`📤 Uploading ${fileName}...`);

  const command = new PutObjectCommand({
    Bucket: config.bucketName,
    Key: key,
    Body: fileContent,
    ContentType: getContentType(fileName),
    ContentDisposition: 'attachment',
  });

  try {
    await s3Client.send(command);
    console.log(`✅ Upload complete!`);

    // download-url.js のハイブリッドアプローチを使ってダウンロード URL を生成
    const downloadUrl = await generateDownloadUrl(key, config.defaultExpirationHours);
    
    const fileSize = (fileContent.length / 1024).toFixed(2);
    console.log(`\n📦 File: ${key} (${fileSize} KB)`);

    return { key, downloadUrl };
  } catch (err) {
    console.error('❌ Upload failed');
    throw new Error('Upload operation failed');
  }
}

function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const types = {
    '.zip': 'application/zip',
    '.apk': 'application/vnd.android.package-archive',
    '.pdf': 'application/pdf',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
  };
  return types[ext] || 'application/octet-stream';
}

// CLI 使用方法
if (require.main === module) {
  const filePath = process.argv[2];
  const s3Key = process.argv[3];

  if (!filePath) {
    console.error('Usage: node upload.js <file-path> [s3-key-name]');
    process.exit(1);
  }

  uploadFile(filePath, s3Key).catch(err => {
    process.exit(1);
  });
}

module.exports = { uploadFile };
