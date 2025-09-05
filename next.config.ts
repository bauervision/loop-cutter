/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export", // ← this replaces `next export`
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true }, // optional: don't block builds on lint
};
module.exports = nextConfig;
