import type { Metadata, Viewport } from "next";
import { PwaRegistration } from "@/components/PwaRegistration";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./settings.css";
import "./sidebar.css";
import "./sidebar-menu.css";

export const metadata: Metadata = {
  title: "omp-web",
  description: "Web view for the omp (oh-my-pi) coding agent",
  applicationName: "omp-web",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "omp-web",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  // Matches --bg in app/globals.css: omp's `light` page surface and the
  // `titanium` brushed-titanium surface.
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#151820" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className="notranslate" suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: `${THEME_INIT_SCRIPT}(function(){try{var r=document.documentElement,m=r.classList.contains("dark")?"dark":"light",c=JSON.parse(localStorage.getItem("omp-theme-config")||"null"),p=c&&c.palettes&&c.palettes[m];r.dataset.ompThemeMode=m;if(p){Object.keys(p.variables).forEach(function(k){r.style.setProperty(k,p.variables[k])});r.dataset.ompThemeName=p.name;r.style.colorScheme=p.colorScheme;r.classList.toggle("dark",p.colorScheme==="dark")}}catch(e){}})();`,
          }}
        />
      </head>
      <body translate="no" className="notranslate" suppressHydrationWarning>
        {children}
        <PwaRegistration />
      </body>
    </html>
  );
}
