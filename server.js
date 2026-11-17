
const express = require("express");
const path = require("path");
const dns = require("dns").promises;
const ipaddr = require("ipaddr.js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

async function validarDestino(valor) {
  const url = new URL(valor);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Somente HTTP e HTTPS são permitidos.");
  }

  if (url.username || url.password) {
    throw new Error("Credenciais na URL não são permitidas.");
  }

  const host = url.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("Endereço local não permitido.");
  }

  let enderecos;

  if (ipaddr.isValid(host)) {
    enderecos = [host];
  } else {
    const resultado = await dns.lookup(host, { all: true });
    enderecos = resultado.map(item => item.address);
  }

  if (!enderecos.length) {
    throw new Error("Servidor não encontrado.");
  }

  for (const endereco of enderecos) {
    const ip = ipaddr.process(endereco);

    if (ip.range() !== "unicast") {
      throw new Error("Endereço IP privado ou reservado não permitido.");
    }
  }

  return url;
}

function proxyUrl(url) {
  return "/proxy?url=" + encodeURIComponent(url);
}

function reescreverPlaylist(texto, baseUrl) {
  return texto.split(/\r?\n/).map(linha => {
    const limpa = linha.trim();

    if (!limpa) return linha;

    if (limpa.startsWith("#")) {
      return linha.replace(/URI="([^"]+)"/g, (match, uri) => {
        try {
          const absoluta = new URL(uri, baseUrl);

          if (!["http:", "https:"].includes(absoluta.protocol)) {
            return match;
          }

          return 'URI="' + proxyUrl(absoluta.href) + '"';
        } catch {
          return match;
        }
      });
    }

    try {
      const absoluta = new URL(limpa, baseUrl);

      if (!["http:", "https:"].includes(absoluta.protocol)) {
        return linha;
      }

      return proxyUrl(absoluta.href);
    } catch {
      return linha;
    }
  }).join("\n");
}

app.get("/proxy", async (req, res) => {
  try {
    const valor = req.query.url;

    if (typeof valor !== "string" || valor.length > 8000) {
      return res.status(400).send("URL inválida.");
    }

    let destino = await validarDestino(valor);
    let resposta;

    for (let tentativa = 0; tentativa < 5; tentativa++) {
      resposta = await fetch(destino.href, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; HLSPlayer/1.0)",
          "Accept": "*/*",
          ...(req.headers.range
            ? { Range: req.headers.range }
            : {})
        }
      });

      if (![301, 302, 303, 307, 308].includes(resposta.status)) {
        break;
      }

      const local = resposta.headers.get("location");

      if (!local) {
        throw new Error("Redirecionamento inválido.");
      }

      destino = await validarDestino(
        new URL(local, destino).href
      );
    }

    if (
      !resposta ||
      [301, 302, 303, 307, 308].includes(resposta.status)
    ) {
      throw new Error("Limite de redirecionamentos atingido.");
    }

    const tipo = resposta.headers.get("content-type") || "";

    const playlist =
      /\.m3u8?($|[?#])/i.test(destino.pathname) ||
      /mpegurl/i.test(tipo);

    res.status(resposta.status);

    res.set({
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": tipo || "application/octet-stream"
    });

    for (const nome of [
      "content-range",
      "accept-ranges"
    ]) {
      const valor = resposta.headers.get(nome);
      if (valor) res.set(nome, valor);
    }

    if (!resposta.body) {
      return res.end();
    }

    if (playlist && resposta.ok) {
      const texto = await resposta.text();

      if (texto.length > 2 * 1024 * 1024) {
        return res.status(413).send("Playlist muito grande.");
      }

      res.type("application/vnd.apple.mpegurl");

      return res.send(
        reescreverPlaylist(texto, destino.href)
      );
    }

    const { Readable } = require("stream");

    Readable.fromWeb(resposta.body).pipe(res);

  } catch (erro) {
    console.error("Erro no proxy:", erro.message);

    if (!res.headersSent) {
      res.status(502).send(
        "Falha ao acessar a transmissão: " + erro.message
      );
    }
  }
});

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Player HTTP iniciado na porta " + PORT);
});
