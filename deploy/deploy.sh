#!/bin/sh
# Builds and uploads to S3, then refreshes the unhashed files on CloudFront.
# Usage: MTG_BUCKET=<bucket> MTG_DISTRIBUTION_ID=<id> npm run deploy
set -eu
: "${MTG_BUCKET:?Set MTG_BUCKET to the S3 bucket name}"
: "${MTG_DISTRIBUTION_ID:?Set MTG_DISTRIBUTION_ID to the CloudFront distribution ID}"

npm run build

# Hashed assets first, so the new index.html never points at missing files.
aws s3 sync dist/assets "s3://$MTG_BUCKET/assets" --cache-control "public, max-age=31536000, immutable"
# OCR files live in a versioned folder, so they can be cached forever too.
aws s3 sync dist/ocr "s3://$MTG_BUCKET/ocr" --cache-control "public, max-age=31536000, immutable"
aws s3 sync dist "s3://$MTG_BUCKET" --delete --exclude "assets/*" --exclude "ocr/*" --cache-control "no-cache"
aws s3 sync dist/ocr "s3://$MTG_BUCKET/ocr" --delete --cache-control "public, max-age=31536000, immutable"
aws s3 sync dist/assets "s3://$MTG_BUCKET/assets" --delete --cache-control "public, max-age=31536000, immutable"

aws cloudfront create-invalidation --distribution-id "$MTG_DISTRIBUTION_ID" \
  --paths /index.html /sw.js /manifest.webmanifest /icon.svg
