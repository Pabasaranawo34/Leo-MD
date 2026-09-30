import http from "node:http";

const PORT = Number(process.env.PORT || 10000);

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        status: "online",
        bot: "Leo MD",
        uptime: Math.floor(process.uptime()),
      })
    );

    return;
  }

  res.writeHead(404, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "Not Found",
    })
  );
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Leo MD Web Server: http://0.0.0.0:${PORT}`);
});