/** @type {import('next').NextConfig} */
module.exports = {
  distDir: '../app', // 👈 This tells Next.js to build into Nextron's "app" folder
  output: 'export', // 👈 This tells Next.js to build a standalone app
  trailingSlash: true,
  devIndicators: false,
  images: {
    unoptimized: true,
  },
  eslint: {
    // Skip lint failures during packaged builds; keep lint in dev where desired
    ignoreDuringBuilds: true,
  },
  webpack: (config) => {
    return config;
  },
};
