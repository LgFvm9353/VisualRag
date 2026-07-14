import "./globals.css";
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" className="h-dvh overflow-hidden">
      <body className="h-full overflow-hidden">
        {children}
      </body>
    </html>
  );
}
