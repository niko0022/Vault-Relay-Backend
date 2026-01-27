const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

const REGION = process.env.AWS_REGION;
const BUCKET = process.env.AWS_S3_BUCKET_NAME;
const PRESIGN_EXPIRES = Number(process.env.S3_UPLOAD_EXPIRES) || 900; // 15 minutes
const SIGNED_GET_EXPIRES = Number(process.env.S3_SIGNED_URL_EXPIRES) || 3600; // 1 hour

if (!REGION || !BUCKET) {
  throw new Error('CRITICAL: Missing AWS_REGION or AWS_S3_BUCKET_NAME environment variables.');
}

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

function getExtension(contentType, originalName) {
  // Try to get extension from Mime Type first
  const ext = mime.extension(contentType);
  if (ext) return ext;

  // Fallback to original filename
  if (originalName && originalName.includes('.')) {
    return originalName.split('.').pop();
  }
  
  return 'bin'; // Default fallback
}

function generateAvatarKey(userId, originalName, contentType) {
  const ext = getExtension(contentType, originalName);
  const safeName = `${Date.now()}-${uuidv4()}.${ext}`;
  return `avatars/${userId}/${safeName}`;
}


async function getPresignedUploadUrl({ userId, contentType, originalName }) {
  const key = generateAvatarKey(userId, originalName, contentType);
  
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });

  const uploadUrl = await getSignedUrl(s3Client, cmd, { expiresIn: PRESIGN_EXPIRES });
  return { uploadUrl, key, expiresIn: PRESIGN_EXPIRES };
}


async function putObjectBuffer({ key, buffer, contentType }) {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  });
  return s3Client.send(cmd);
}


async function headObject(key) {
  const cmd = new HeadObjectCommand({ Bucket: BUCKET, Key: key });
  return s3Client.send(cmd);
}


async function deleteObject(key) {
  const cmd = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
  return s3Client.send(cmd);
}

/**
 * Generate a signed URL for viewing/downloading a private file.
 * @param {string} key 
 * @param {string} [downloadName] 
 */
async function getSignedGetUrl(key, downloadName = null) {
  const params = {
    Bucket: BUCKET,
    Key: key,
  };

  // If a name is provided, force the browser to download it as that name
  if (downloadName) {
    params.ResponseContentDisposition = `attachment; filename="${downloadName}"`;
  }

  const cmd = new GetObjectCommand(params);
  return getSignedUrl(s3Client, cmd, { expiresIn: SIGNED_GET_EXPIRES });
}

module.exports = {
  getPresignedUploadUrl,
  putObjectBuffer,
  headObject,
  deleteObject,
  getSignedGetUrl,
  s3Client,
};