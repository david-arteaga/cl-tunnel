const PORT = process.env.PORT || 3500;

Bun.serve({
  fetch(request, server) {
    console.log(request.method, request.url);
    return Response.json({
      time: new Date().toISOString(),
    });
  },
  port: PORT,
});

console.log(`Server is running on port ${PORT}`);
