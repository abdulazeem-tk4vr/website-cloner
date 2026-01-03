/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow serving files from public/temp
  async headers() {
    return [
      {
        source: '/temp/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, max-age=0',
          },
        ],
      },
    ];
  },
  // Disable image optimization for temp assets
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
