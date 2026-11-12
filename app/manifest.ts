import type { MetadataRoute } from "next";

// What a phone shows when HEAT is added to the home screen, and how it opens.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HEAT · Know your menu",
    short_name: "HEAT",
    description: "Menu knowledge, ready for service.",
    start_url: "/",
    display: "standalone",
    // The page color (--c-bg), shown behind the logo while HEAT opens.
    background_color: "#F1F1EC",
    theme_color: "#F1F1EC",
    // Android asks for PNGs at 192 and 512; "maskable" keeps the mark whole in round or squircle icons.
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
