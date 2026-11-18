FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first for better layer caching.
COPY package*.json ./
RUN npm ci

# Application source and Prisma schema.
COPY . .

# Generate the Prisma client and build the Next.js app.
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Run the web process. Run the worker as a separate container/process:
#   npm run worker
CMD ["npm", "start", "--", "-p", "3000"]