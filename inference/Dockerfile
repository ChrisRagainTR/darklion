FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global @openai/codex@0.156.1 && npm cache clean --force
WORKDIR /service
COPY *.cjs ./
RUN mkdir -p /home/node/.codex && chown -R node:node /home/node/.codex /service
USER node
EXPOSE 8080
CMD ["node", "server.cjs"]
