# Base stage for common settings
FROM ghcr.io/puppeteer/puppeteer:latest AS base
USER root
WORKDIR /app
RUN chown -R pptruser:pptruser /app
USER pptruser

# Dependencies stage
FROM base AS dependencies
COPY --chown=pptruser:pptruser package.json yarn.lock .yarnrc.yml ./
COPY --chown=pptruser:pptruser .yarn .yarn
RUN yarn install --immutable

# Builder stage
FROM dependencies AS builder
COPY --chown=pptruser:pptruser src/ src/

# Final stage for production
FROM builder AS release
CMD ["yarn", "start"]
