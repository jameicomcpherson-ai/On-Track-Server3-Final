#!/bin/bash

# On Track - Railway Deployment Script
# This script runs after the build phase

echo "🚀 Starting On Track Backend..."

# Generate Prisma Client (in case it wasn't generated during build)
echo "📦 Generating Prisma Client..."
npx prisma generate

# Run database migrations (optional - uncomment if you want auto-migrations)
# echo "🗄️ Running database migrations..."
# npx prisma migrate deploy

# Start the server
echo "✅ Starting server..."
npm start
