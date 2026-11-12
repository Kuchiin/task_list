const express = require('express');
const { expressjwt: jwt } = require('express-jwt');
const jwksRsa = require('jwks-rsa');
const { Pool } = require('pg');
const cors = require('cors'); // Potrzebne do komunikacji z frontendem

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

const KEYCLOAK_INTERNAL_URL =
  process.env.KEYCLOAK_INTERNAL_URL || 'http://keycloak:8080';

const KEYCLOAK_PUBLIC_URL =
  process.env.KEYCLOAK_PUBLIC_URL || 'http://localhost:8080';

const KEYCLOAK_REALM =
  process.env.KEYCLOAK_REALM || 'task-app-realm';

const KEYCLOAK_AUDIENCE =
  process.env.KEYCLOAK_AUDIENCE || 'task-app-frontend';

const KEYCLOAK_ISSUER =
  `${KEYCLOAK_PUBLIC_URL}/realms/${KEYCLOAK_REALM}`;

app.use(cors()); // Włączamy CORS dla wszystkich domen na potrzeby developmentu
app.use(express.json()); // Do parsowania JSON z requestów

app.use((req, res, next) => {
  console.log('Incoming request', req.method, req.url, 'Authorization:', req.headers.authorization ? 'present' : 'absent');
  next();
});

const checkJwt = jwt({
  secret: jwksRsa.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,

    jwksUri:
      `${KEYCLOAK_INTERNAL_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
  }),

  issuer: KEYCLOAK_ISSUER,

  algorithms: ['RS256'],
});

function getCurrentUserId(req) {
  return req.auth?.sub;
}

function requireRole(role) {
  return (req, res, next) => {
    const roles = req.auth?.realm_access?.roles;
    if (!Array.isArray(roles) || !roles.includes(role)) {
      return res.status(403).json({ error: 'Forbidden', message: `User requires role ${role}` });
    }
    next();
  };
}

// Konfiguracja bazy danych PostgreSQL
const pool = new Pool({
  user: process.env.APP_DB_USER,
  host: process.env.APP_DB_HOST,
  database: process.env.APP_DB_NAME,
  password: process.env.APP_DB_PASSWORD,
  port: process.env.APP_DB_PORT,
});

// Funkcja do inicjalizacji bazy danych (tworzenie tabeli)
async function initializeDatabase() {
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(80) NOT NULL,
        description VARCHAR(200),
        status VARCHAR(50) DEFAULT 'todo',
        position INTEGER
      );
    `);

    await client.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS position INTEGER;');
    await client.query('ALTER TABLE tasks ALTER COLUMN position SET DEFAULT 0;');
    await client.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS owner_id VARCHAR(100);');
    await client.query("UPDATE tasks SET owner_id = 'unknown' WHERE owner_id IS NULL;");
    await client.query('ALTER TABLE tasks ALTER COLUMN owner_id SET NOT NULL;');

    await client.query(`
      WITH numbered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS new_position
        FROM tasks
      )
      UPDATE tasks t
      SET position = numbered.new_position
      FROM numbered
      WHERE t.id = numbered.id AND t.position IS NULL;
    `);

    await client.query(`
      WITH numbered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) - 1 AS new_position
        FROM tasks
      )
      UPDATE tasks t
      SET position = numbered.new_position
      FROM numbered
      WHERE t.id = numbered.id;
    `);

    await client.query('ALTER TABLE tasks ALTER COLUMN position SET NOT NULL;');
    await client.query('CREATE INDEX IF NOT EXISTS idx_tasks_position ON tasks(position);');

    console.log('Tasks table ensured to exist.');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    client.release();
  }
}

// --- Endpointy API ---

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1'); // Prosty test połączenia z bazą danych
    res.status(200).json({ status: 'UP', database: 'CONNECTED' });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ status: 'DOWN', database: 'DISCONNECTED', error: err.message });
  }
});

// Endpoint wymagający roli admin
app.get('/admin/check', checkJwt, requireRole('admin'), (req, res) => {
  res.status(200).json({ message: 'jesteś adminem!' });
});

// Dodaj nowe zadanie
app.use('/tasks', checkJwt, (req, res, next) => {
  if (req.auth?.azp !== KEYCLOAK_AUDIENCE) {
    return res.status(401).json({ error: 'Invalid token audience' });
  }
  next();
});

app.post('/tasks', async (req, res) => {
  const userId = getCurrentUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { title, description, status } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  try {
    const nextPositionResult = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS next_position FROM tasks WHERE owner_id = $1', [userId]);
    const nextPosition = Number(nextPositionResult.rows[0].next_position);

    const result = await pool.query(
      'INSERT INTO tasks (title, description, status, position, owner_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, description || null, status || 'todo', nextPosition, userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating task:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Pobierz wszystkie zadania (zabezpieczony w przyszłości)
app.get('/tasks', async (req, res) => {
  const userId = getCurrentUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await pool.query('SELECT * FROM tasks WHERE owner_id = $1 ORDER BY position ASC, id ASC', [userId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Usuń zadanie (zabezpieczony w przyszłości)
app.delete('/tasks/:id', async (req, res) => {
  const userId = getCurrentUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1 AND owner_id = $2 RETURNING *', [id, userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    await pool.query(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) - 1 AS new_position
        FROM tasks
        WHERE owner_id = $1
      )
      UPDATE tasks t
      SET position = ranked.new_position
      FROM ranked
      WHERE t.id = ranked.id;
    `, [userId]);

    res.status(200).json({ message: 'Task deleted', task: result.rows[0] });
  } catch (err) {
    console.error('Error deleting task:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/tasks/order', async (req, res) => {
  const { taskOrder } = req.body;

  if (!Array.isArray(taskOrder)) {
    return res.status(400).json({ error: 'taskOrder array is required' });
  }

  const normalizedOrder = taskOrder.map(Number);

  if (normalizedOrder.length === 0) {
    return res.status(400).json({ error: 'taskOrder must not be empty' });
  }

  const uniqueIds = new Set(normalizedOrder);
  if (uniqueIds.size !== normalizedOrder.length) {
    return res.status(400).json({ error: 'taskOrder must contain unique task ids' });
  }

  try {
    const userId = getCurrentUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const existingTasksResult = await pool.query('SELECT id FROM tasks WHERE id = ANY($1) AND owner_id = $2', [normalizedOrder, userId]);
    if (existingTasksResult.rowCount !== normalizedOrder.length) {
      return res.status(404).json({ error: 'Some tasks were not found' });
    }

    await pool.query('BEGIN');

    for (let index = 0; index < normalizedOrder.length; index += 1) {
      await pool.query('UPDATE tasks SET position = $1 WHERE id = $2 AND owner_id = $3', [index, normalizedOrder[index], userId]);
    }

    await pool.query('COMMIT');

    const result = await pool.query('SELECT * FROM tasks WHERE owner_id = $1 ORDER BY position ASC, id ASC', [userId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error updating task order:', err);
    try {
      await pool.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Error rolling back task order transaction:', rollbackErr);
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/tasks/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (typeof status !== 'string' || status.trim() === '') {
    return res.status(400).json({ error: 'Status is required' });
  }

  try {
    const userId = getCurrentUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await pool.query(
      'UPDATE tasks SET status = $1 WHERE id = $2 AND owner_id = $3 RETURNING *',
      [status.trim(), id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error updating task status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Pobierz pojedyncze zadanie (zabezpieczony w przyszłości)
app.get('/tasks/:id', async (req, res) => {
  const userId = getCurrentUserId(req);
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE id = $1 AND owner_id = $2', [id, userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching task:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.use((err, req, res, next) => {
  if (err.name === 'UnauthorizedError') {
    console.error('JWT authorization failed:', err);
    return res.status(401).json({ error: 'Invalid token' });
  }
  next(err);
});

// Start serwera po inicjalizacji bazy danych
initializeDatabase().then(() => {
  const server = app.listen(port, () => {
    console.log(`Backend app listening at http://0.0.0.0:${port}`);
  });

  // Graceful shutdown handler
  const gracefulShutdown = async (signal) => {
    console.log(`Received ${signal}, starting graceful shutdown...`);

    // Przestaniemy akceptować nowe requesty
    server.close(async () => {
      console.log('HTTP server closed');

      // Zamykamy przepływ połączeń do bazy danych
      try {
        await pool.end();
        console.log('Database connections closed');
      } catch (err) {
        console.error('Error closing database pool:', err);
      }

      console.log('Graceful shutdown completed');
      process.exit(0);
    });

    // Timeout: jeśli shutdown trwa za długo, wymuś wyjście
    setTimeout(() => {
      console.error('Graceful shutdown timeout, forcing exit');
      process.exit(1);
    }, 10000); // 10 sekund timeout
  };

  // Obsługa SIGTERM (wysyłany przez Docker)
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Obsługa SIGINT (Ctrl+C)
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Obsługa nieobsłużonych wyjątków
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    gracefulShutdown('uncaughtException');
  });
});
