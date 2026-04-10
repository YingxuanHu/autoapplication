import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  onDemandEntries: {
    maxInactiveAge: 15 * 1000,
    pagesBufferLength: 1,
  },
  serverExternalPackages: [
    "mammoth",
    "pdf-parse",
    "pdfjs-dist",
    "word-extractor",
  ],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
