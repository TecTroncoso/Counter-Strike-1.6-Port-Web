import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "CS 1.6 Web Port — Counter-Strike 1.6 en tu navegador",
  // Evita que la extensión Dark Reader reescriba estilos/atributos del DOM,
  // lo que provoca errores de hidratación de React (mismos atributos ≠ SSR).
  other: { "darkreader-lock": "true" },
  description:
    "Port web del Counter-Strike 1.6 real: motor Xash3D (compatible GoldSrc) compilado a WebAssembly, lógica de juego open-source (cs16-client + ReGameDLL) y bots YaPB. Juega con bots o multijugador.",
  keywords: ["Counter-Strike 1.6", "Xash3D", "WebAssembly", "GoldSrc", "FPS", "web port", "bots", "multijugador"],
  icons: {
    icon: "/logo.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0e1210",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground" suppressHydrationWarning>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
