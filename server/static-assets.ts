import express, { type Express } from "express";
import { stat } from "node:fs/promises";
import { resolve, extname } from "node:path";

export function staticAssets(app: Express) {
  app.use("/assets", async (req, res, next) => {
    if (
      !["GET", "HEAD"].includes(req.method) ||
      !/^\/[A-Za-z0-9_.-]+\.(js|css|svg|json)$/.test(req.path)
    )
      return next();
    res.vary("Accept-Encoding");
    const encoding = req.acceptsEncodings("br", "gzip", "identity");
    if (encoding !== "br" && encoding !== "gzip") return next();
    const file = resolve(
      "dist/assets",
      req.path.slice(1) + (encoding === "br" ? ".br" : ".gz"),
    );
    try {
      await stat(file);
    } catch {
      return next();
    }
    res.type(extname(req.path)).set({
      "Content-Encoding": encoding,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.sendFile(file, (error) => {
      if (error) next(error);
    });
  });
  app.use(
    express.static("dist", {
      setHeaders: (res, path) => {
        if (/\.(js|css|svg|json)$/.test(path)) res.vary("Accept-Encoding");
        res.setHeader(
          "Cache-Control",
          path.endsWith(".html")
            ? "no-cache"
            : path.includes("/assets/")
              ? "public, max-age=31536000, immutable"
              : "public, max-age=300",
        );
      },
    }),
  );
}
