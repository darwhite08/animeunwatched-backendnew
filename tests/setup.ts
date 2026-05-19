// Ensure dotenv is not needed in tests — we mock the db and env
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET  = "test-access-secret-min-32-chars-long!";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-min-32-chars-long!";
process.env.JWT_ACCESS_EXPIRY  = "15m";
process.env.JWT_REFRESH_EXPIRY = "7d";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
