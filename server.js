
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const ALLOWED_HOSTS = (
  process.env.ALLOWED_HOSTS || "170.83.16.50"
).split(",").map(h => h.trim().toLowerCase());

function validarUrl(valor) {
  const url = new URL(valor);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Protocolo não permitido.");
  }

  if (!ALLOWED_HOSTS.includes(url.hostname.toLowerCase())) {
    throw new Error("Servidor não autorizado: " + url.hostname);
  }

  if (url.username || url.password) {
    throw new Error("Credenciais na URL não permitidas.");
  }

  return url;
}

function enderecoProxy(url) {
  return "/proxy?url=" + encodeURIComponent(url);
}

function reescreverPlaylist(texto, baseUrl) {
  return texto.split(/\r?\n/).map(linha => {
    const limpa = linha.trim();

    if (!limpa) return linha;

    if (limpa.startsWith("#")) {
      return linha.replace(/URI="([^"]+)"/g, (match, uri) => {
        const absoluta = new URL(uri, baseUrl).href;
        return 'URI="' + enderecoProxy(absoluta) + '"';
      });
    }

    const absoluta = new URL(limpa, baseUrl).href;
    return enderecoProxy(absoluta);
  }).join("\n");
}

app.get("/proxy", async (req, res) => {
  try {
    if (!req.query.url || req.query.url.length > 8000) {
      return res.status(400).send("URL inválida.");
    }

    let destino = validarUrl(req.query.url);
    let resposta;

    for (let tentativa = 0; tentativa < 5; tentativa++) {
      resposta = await fetch(destino.href, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 HLS Player",
          ...(req.headers.range
            ? { Range: req.headers.range }
            : {})
        }
      });

      if (![301, 302, 303, 307, 308].includes(resposta.status)) {
        break;
      }

      const local = resposta.headers.get("location");
      if (!local) throw new Error("Redirecionamento inválido.");

      destino = validarUrl(new URL(local, destino).href);
    }

    if (!resposta || [301, 302, 303, 307, 308].includes(resposta.status)) {
      throw new Error("Muitos redirecionamentos.");
    }

    const tipo = resposta.headers.get("content-type") || "";
    const parecePlaylist =
      /\.m3u8?($|\?)/i.test(destino.href) ||
      tipo.toLowerCase().includes("mpegurl");

    res.status(resposta.status);

    res.set({
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": tipo || "application/octet-stream"
    });

    for (const nome of ["content-range", "accept-ranges"]) {
      const valor = resposta.headers.get(nome);
      if (valor) res.set(nome, valor);
    }

    if (!resposta.body) return res.end();

    if (parecePlaylist && resposta.ok) {
      const texto = await resposta.text();
      res.type("application/vnd.apple.mpegurl");
      return res.send(reescreverPlaylist(texto, destino.href));
    }

    const { Readable } = require("stream");
    Readable.fromWeb(resposta.body).pipe(res);

  } catch (erro) {
    console.error("Erro no proxy:", erro.message);
    if (!res.headersSent) {
      res.status(502).send("Falha ao acessar a transmissão: " + erro.message);
    }
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Player HTTP iniciado na porta " + PORT);
});
