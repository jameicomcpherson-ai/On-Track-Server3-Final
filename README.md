# On Track - Backend API

Fintech debt payoff backend with Plaid & Lithic integration.

## Tech Stack

- Node.js + Express + TypeScript
- Prisma ORM + PostgreSQL
- Plaid (bank linking)
- Lithic (transaction intervention)

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

```bash
DATABASE_URL="postgresql://..."
JWT_SECRET="your-secret"
PLAID_CLIENT_ID="..."
PLAID_SECRET="..."
LITHIC_API_KEY="..."
```

## Deployment

1. Push to GitHub
2. Connect Railway to your repo
3. Set environment variables in Railway dashboard
4. Deploy!

## API Endpoints

- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `GET /api/users/me` - Get current user
- `GET /api/liabilities` - Get all debts
- `POST /api/plaid/link-token` - Create Plaid link token
- `POST /api/lithic/sandbox/simulate` - Test intervention (sandbox only)

## License

MIT
