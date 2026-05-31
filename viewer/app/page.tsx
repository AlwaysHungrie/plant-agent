import Gallery, { type ImageItem } from "./gallery";
import ChatDrawer from "./components/chat-drawer";

const API_BASE = "https://message-api.dhairyashah98.workers.dev";

type ImagesResponse = {
  page: number;
  limit: number;
  results: ImageItem[];
};

async function fetchImages(): Promise<ImageItem[]> {
  const res = await fetch(`${API_BASE}/images?page=1&limit=100`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  const data: ImagesResponse = await res.json();
  return data.results ?? [];
}

export default async function Home() {
  const images = await fetchImages();
  return (
    <main className="fixed inset-0 overflow-hidden bg-cctv text-white">
      {/* Full-bleed CCTV feed */}
      <Gallery images={images} />
      {/* Floating app panel — pinned right on desktop, drawer on mobile */}
      <ChatDrawer />
    </main>
  );
}
