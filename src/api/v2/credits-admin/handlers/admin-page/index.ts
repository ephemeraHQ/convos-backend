import crypto from "node:crypto";
import type { Request, Response } from "express";
import { consoleView } from "./console-view";
import { loginView } from "./login-view";
import { clientScript } from "./script";
import { STYLES } from "./styles";

export const adminPageHandler = (_req: Request, res: Response): void => {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.removeHeader("Content-Security-Policy");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
  );
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Credits Admin — Convos</title>
<style>${STYLES}</style>
</head>
<body>
${loginView()}
${consoleView()}
<script nonce="${nonce}">${clientScript()}</script>
</body>
</html>`);
};
