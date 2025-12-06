const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

// --- config ---
const REGION = process.env.AWS_REGION 
const BUCKET = process.env.AWS_S3_BUCKET_NAME 
const PRESIGN_EXPIRES = Number(process.env.S3_UPLOAD_EXPIRES) || 900; 
const SIGNED_GET_EXPIRES = Number(process.env.S3_SIGNED_URL_EXPIRES) || 3600; 

//  explicit creds
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY;

if (!REGION || !BUCKET) {
  console.warn('Warning: Missing AWS_REGION or S3 bucket env vars');
}

// Create S3 client — prefer explicit credentials if provided.
const s3Client = AWS_ACCESS_KEY_ID && AWS_SECRET_KEY
  ? new S3Client({
      region: REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_KEY,
      },
    })
  : new S3Client({ region: REGION });

// --- helpers ---
function normalizeExtensionFromContentType(contentType) {
  return mime.extension(contentType) || 'bin';
}

function generateAvatarKey(userId, originalName, contentType) {
  const ext = contentType
    ? normalizeExtensionFromContentType(contentType)
    : (originalName ? originalName.split('.').pop() : 'jpg');
  const safeName = `${Date.now()}-${uuidv4()}.${ext}`;
  return `avatars/${userId}/${safeName}`;
}

// Server-side presigned PUT URL for client->S3 uploads (used when doing client direct uploads)
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

// Optionally: server-side helper to PUT a buffer directly from Node (if you want server->S3 uploads)
async function putObjectBuffer({ key, buffer, contentType }) {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  });
  return s3Client.send(cmd);
}

// HEAD: return metadata (ContentType, ContentLength, etc.)
async function headObject(key) {
  const cmd = new HeadObjectCommand({ Bucket: BUCKET, Key: key });
  return s3Client.send(cmd);
}

// DELETE object
async function deleteObject(key) {
  const cmd = new DeleteObjectCommand({ Bucket: BUCKET, Key: key });
  return s3Client.send(cmd);
}

// Signed GET url to allow temporary downloads of private objects
async function getSignedGetUrl(key, expires = SIGNED_GET_EXPIRES) {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3Client, cmd, { expiresIn: expires });
}

module.exports = {
  // exported functions
  getPresignedUploadUrl,
  putObjectBuffer,
  headObject,
  deleteObject,
  getSignedGetUrl,
  s3Client, // export client for testing or advanced operations
};