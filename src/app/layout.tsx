import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MFBMT Procurement",
  description: "Enquiry intake, stock checks, supplier sourcing and owner approvals for MFBMT.",
};

export const viewport: Viewport = {
  themeColor: "#0B1020",
};

const themeScript = `(function(){try{var t=localStorage.getItem("mfbmt-theme");if(t==="light"){document.documentElement.classList.add("light");}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
