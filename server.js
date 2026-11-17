
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


// Resolve arquivos de referência M3U8 hospedados no GitHub Raw.
// Esses arquivos contêm somente a URL real da transmissão, não uma playlist HLS.
async function buscarComRedirecionamentos(urlInicial) {
  let destino = await validarDestino(urlInicial);
  let resposta;

  for (let tentativa = 0; tentativa < 5; tentativa++) {
    resposta = await fetch(destino.href, {
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HLSPlayer/1.0)",
        "Accept": "*/*"
      }
    });

    if (![301, 302, 303, 307, 308].includes(resposta.status)) {
      break;
    }

    const local = resposta.headers.get("location");
    if (!local) throw new Error("Redirecionamento inválido.");

    destino = await validarDestino(new URL(local, destino).href);
  }

  if (!resposta || [301, 302, 303, 307, 308].includes(resposta.status)) {
    throw new Error("Limite de redirecionamentos atingido.");
  }

  return { destino, resposta };
}

app.get("/resolver", async (req, res) => {
  try {
    const valor = req.query.url;

    if (typeof valor !== "string" || valor.length > 8000) {
      return res.status(400).json({ erro: "URL inválida." });
    }

    const origem = await validarDestino(valor);

    // Links diretos continuam sem alteração. Só precisamos ler os arquivos
    // de texto publicados no endpoint GitHub Raw.
    if (origem.hostname.toLowerCase() !== "raw.githubusercontent.com") {
      return res.json({ url: origem.href });
    }

    const { destino, resposta } = await buscarComRedirecionamentos(origem.href);

    if (!resposta.ok) {
      return res.status(502).json({
        erro: "Não foi possível ler o arquivo de referência (HTTP " + resposta.status + ")."
      });
    }

    const texto = await resposta.text();

    if (texto.length > 128 * 1024) {
      return res.status(413).json({ erro: "Arquivo de referência muito grande." });
    }

    // Playlist HLS verdadeira: mantém o endereço original para o proxy atual.
    if (/^\s*#EXTM3U\b/m.test(texto)) {
      return res.json({ url: destino.href });
    }

    // Arquivo de referência: procura a primeira linha que contenha uma URL.
    const linhaUrl = texto
      .split(/\r?\n/)
      .map(linha => linha.trim())
      .find(linha => linha && !linha.startsWith("#"));

    if (!linhaUrl) {
      return res.status(422).json({
        erro: "O arquivo não contém uma URL de transmissão."
      });
    }

    let enderecoReal;
    try {
      enderecoReal = new URL(linhaUrl, destino.href);
    } catch {
      return res.status(422).json({ erro: "A URL dentro do arquivo é inválida." });
    }

    if (!["http:", "https:"].includes(enderecoReal.protocol)) {
      return res.status(422).json({ erro: "A URL da transmissão deve usar HTTP ou HTTPS." });
    }

    // Valida também o destino extraído para impedir endereços locais/privados.
    const urlValidada = await validarDestino(enderecoReal.href);

    return res.json({ url: urlValidada.href });
  } catch (erro) {
    console.error("Erro ao resolver referência:", erro.message);
    return res.status(502).json({ erro: "Falha ao resolver endereço: " + erro.message });
  }
});

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
