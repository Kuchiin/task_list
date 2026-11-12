import React, { useState, useEffect, useRef } from 'react';
import { ReactKeycloakProvider } from '@react-keycloak/web';
import Keycloak, { KeycloakConfig } from 'keycloak-js';
import axios from 'axios';

interface Task {
  id: number;
  title: string;
  description: string | null;
  status: string;
}

const apiMeta = import.meta as unknown as {
  env?: {
    VITE_API_BASE_URL?: string;
    VITE_KEYCLOAK_URL?: string;
    VITE_KEYCLOAK_REALM?: string;
    VITE_KEYCLOAK_CLIENT_ID?: string;
  };
};
const API_BASE_URL = apiMeta.env?.VITE_API_BASE_URL || '/api2';
const KEYCLOAK_URL = apiMeta.env?.VITE_KEYCLOAK_URL || 'http://localhost:8080';
const KEYCLOAK_REALM = apiMeta.env?.VITE_KEYCLOAK_REALM || 'task-app-realm';
const KEYCLOAK_CLIENT_ID = apiMeta.env?.VITE_KEYCLOAK_CLIENT_ID || 'task-app-frontend';

const api = axios.create({
  baseURL: API_BASE_URL,
});

api.interceptors.request.use((config) => {
  console.log('Axios request:', config.method, config.url, config.headers?.Authorization);
  return config;
});

const keycloakConfig: KeycloakConfig = {
  url: KEYCLOAK_URL,
  realm: KEYCLOAK_REALM,
  clientId: KEYCLOAK_CLIENT_ID,
};

const keycloak: Keycloak = new Keycloak(keycloakConfig);

async function getToken(): Promise<string | null> {
  if (!keycloak.authenticated) {
    console.warn('Keycloak not authenticated when getToken() called');
    return null;
  }

  try {
    await keycloak.updateToken(30);
  } catch (err) {
    console.error('Failed to refresh Keycloak token:', err);
  }

  console.log('Keycloak token state:', {
    authenticated: keycloak.authenticated,
    token: keycloak.token?.slice(0, 20) + '...',
    issuer: keycloak.tokenParsed?.iss,
    audience: keycloak.tokenParsed?.aud,
    tokenParsed: keycloak.tokenParsed,
  });

  return keycloak.token ?? null;
}

async function getAuthConfig(token?: string) {
  const accessToken = token || (await getToken());
  if (!accessToken) {
    console.warn('No access token available for API request');
  }
  return accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {};
}

function App() {
  const [initialized, setInitialized] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState<string>('');
  const [newTaskDescription, setNewTaskDescription] = useState<string>('');
  const [draggedTaskId, setDraggedTaskId] = useState<number | null>(null);
  const [adminMessage, setAdminMessage] = useState<string | null>(null);
  const isMounted = useRef(false);

  const userHasRole = (role: string): boolean => {
    const parsed = keycloak.tokenParsed as any;
    return Array.isArray(parsed?.realm_access?.roles) && parsed.realm_access.roles.includes(role);
  };

  const fetchAdminMessage = async () => {
    try {
      const config = await getAuthConfig();
      const response = await api.get<{ message: string }>('/admin/check', config);
      setAdminMessage(response.data.message);
    } catch (error: unknown) {
      console.error('Failed to verify admin role:', error);
      if (axios.isAxiosError(error) && error.response?.status === 403) {
        setAdminMessage('Odmowa dostępu, nie jesteś adminem!');
      } else {
        setAdminMessage('Błąd podczas sprawdzania uprawnień.');
      }
    }
  };

  const fetchTasks = async (token?: string) => {
    try {
      const config = await getAuthConfig(token);
      const response = await api.get<Task[]>('/tasks', config);
      setTasks(response.data);
    } catch (error: unknown) {
      console.error('Failed to fetch tasks:', error);
    }
  };

  useEffect(() => {
    isMounted.current = true;
    const timeout = window.setTimeout(() => {
      if (!initialized && isMounted.current) {
        setAuthError('Keycloak could not be reached. Check that the Docker services are running and reload the page.');
      }
    }, 10000);

    return () => {
      isMounted.current = false;
      window.clearTimeout(timeout);
    };
  }, [initialized]);

  const onKeycloakEvent = (event: string) => {
    console.log('Keycloak Event:', event, {
      authenticated: keycloak.authenticated,
      token: keycloak.token ? keycloak.token.slice(0, 20) + '...' : null,
    });

    if (event === 'onAuthSuccess' || event === 'onAuthRefresh' || (event === 'onReady' && keycloak.authenticated)) {
      if (isMounted.current && keycloak.token) {
        void fetchTasks(keycloak.token);
        setInitialized(true);
      }
    } else if (event === 'onAuthLogout' || event === 'onAuthError' || (event === 'onReady' && !keycloak.authenticated)) {
      if (isMounted.current) {
        setTasks([]);
        setInitialized(true);
      }
    }
  };

  const onKeycloakTokens = (tokens: { token?: string }) => {
    console.log('Tokens received:', tokens);
    if (keycloak.authenticated && isMounted.current && tokens.token) {
      void fetchTasks(tokens.token);
    }
  };

  const handleAddTask = async () => {
    const trimmedTitle = newTaskTitle.trim();
    if (!trimmedTitle) return;

    try {
      const config = await getAuthConfig();
      const response = await api.post<Task>('/tasks', {
        title: trimmedTitle,
        description: newTaskDescription.trim() || null,
        status: 'todo',
      }, config);

      setTasks((prevTasks) => [...prevTasks, response.data]);
      setNewTaskTitle('');
      setNewTaskDescription('');
    } catch (error: unknown) {
      console.error('Failed to add task:', error);
    }
  };

  const handleDeleteTask = async (taskId: number) => {
    try {
      const config = await getAuthConfig();
      await api.delete(`/tasks/${taskId}`, config);
      setTasks((prevTasks) => prevTasks.filter((task) => task.id !== taskId));
    } catch (error: unknown) {
      console.error('Failed to delete task:', error);
    }
  };

  const handleToggleTaskStatus = async (task: Task) => {
    const nextStatus = task.status === 'todo' ? 'done' : 'todo';

    try {
      const config = await getAuthConfig();
      const response = await api.patch<Task>(`/tasks/${task.id}/status`, {
        status: nextStatus,
      }, config);

      setTasks((prevTasks) => prevTasks.map((currentTask) => currentTask.id === task.id ? response.data : currentTask));
    } catch (error: unknown) {
      console.error('Failed to update task status:', error);
    }
  };

  const persistTaskOrder = async (orderedTasks: Task[]) => {
    try {
      const config = await getAuthConfig();
      await api.patch('/tasks/order', {
        taskOrder: orderedTasks.map((task) => task.id),
      }, config);
    } catch (error: unknown) {
      console.error('Failed to persist task order:', error);
    }
  };

  const handleDragStart = (taskId: number) => {
    setDraggedTaskId(taskId);
  };

  const handleDrop = (targetTaskId: number) => {
    if (draggedTaskId === null || draggedTaskId === targetTaskId) {
      setDraggedTaskId(null);
      return;
    }

    setTasks((prevTasks) => {
      const updatedTasks = [...prevTasks];
      const draggedIndex = updatedTasks.findIndex((task) => task.id === draggedTaskId);
      const targetIndex = updatedTasks.findIndex((task) => task.id === targetTaskId);

      if (draggedIndex === -1 || targetIndex === -1) {
        return prevTasks;
      }

      const [draggedTask] = updatedTasks.splice(draggedIndex, 1);
      updatedTasks.splice(targetIndex, 0, draggedTask);

      void persistTaskOrder(updatedTasks);
      return updatedTasks;
    });

    setDraggedTaskId(null);
  };

  return (
    <ReactKeycloakProvider
      authClient={keycloak}
      initOptions={{ pkceMethod: 'S256', onLoad: 'check-sso', redirectUri: window.location.origin + '/frontend/' }}
      onEvent={onKeycloakEvent}
      onTokens={onKeycloakTokens}
    >
      <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif', maxWidth: '900px', margin: '0 auto' }}>
        <h1>Task Management App</h1>
        {!initialized && !authError && <p>Connecting to secure sign-in…</p>}
        {authError && (
          <div style={{ marginTop: '20px', padding: '16px', borderRadius: '8px', backgroundColor: '#fff3cd', color: '#664d03' }}>
            <strong>Authentication is unavailable.</strong>
            <p>{authError}</p>
            <button onClick={() => window.location.reload()} style={{ padding: '8px 14px' }}>
              Retry
            </button>
          </div>
        )}
        {initialized && (
          <div>
            {!keycloak.authenticated ? (
              <div>
                <p>Zaloguj się, aby zobaczyć i zarządzać zadaniami.</p>
                <button onClick={() => keycloak.login()} style={{ padding: '10px 20px', fontSize: '16px' }}>
                  Login
                </button>
              </div>
            ) : (
              <div>
                <p>Witaj, {keycloak.tokenParsed?.preferred_username}!</p>
                <button onClick={() => keycloak.logout()} style={{ padding: '10px 20px', fontSize: '16px', backgroundColor: '#dc3545', color: 'white', border: 'none' }}>
                  Logout
                </button>

                {userHasRole('admin') && (
                  <section style={{ marginTop: '24px', border: '1px solid #b98b00', borderRadius: '8px', padding: '16px', backgroundColor: '#000000' }}>
                    <h2 style={{ marginTop: 0 }}>Panel administratora</h2>
                    <button
                      onClick={() => void fetchAdminMessage()}
                      style={{ padding: '10px 15px', backgroundColor: '#b98b00', color: '#212529', border: 'none', fontSize: '16px', cursor: 'pointer' }}
                    >
                      Sprawdź, czy jesteś adminem
                    </button>
                    {adminMessage && <p style={{ marginTop: '12px', fontWeight: 700 }}>{adminMessage}</p>}
                  </section>
                )}

                <section style={{ marginTop: '24px', border: '1px solid #ddd', borderRadius: '8px', padding: '16px', backgroundColor: '#fafafa' }}>
                  <h2 style={{ marginTop: 0 }}>Dodaj nowe zadanie</h2>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <input
                      type="text"
                      placeholder="Tytuł zadania"
                      value={newTaskTitle}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewTaskTitle(e.target.value)}
                      style={{ padding: '10px', fontSize: '16px' }}
                    />
                    <textarea
                      placeholder="Opis zadania (opcjonalnie)"
                      value={newTaskDescription}
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setNewTaskDescription(e.target.value)}
                      rows={4}
                      style={{ padding: '10px', fontSize: '16px', resize: 'vertical' }}
                    />
                    <button
                      onClick={() => void handleAddTask()}
                      style={{ padding: '10px 15px', backgroundColor: '#28a745', color: 'white', border: 'none', fontSize: '16px', cursor: 'pointer' }}
                    >
                      Dodaj zadanie
                    </button>
                  </div>
                </section>

                <section style={{ marginTop: '24px' }}>
                  <h2>Twoje zadania</h2>
                  <p style={{ color: '#666' }}>Przeciągnij zadanie, aby zmienić jego kolejność.</p>
                  <ul style={{ listStyleType: 'none', padding: 0, margin: 0 }}>
                    {tasks.map((task: Task) => {
                      const isDone = task.status === 'done';

                      return (
                        <li
                          key={task.id}
                          draggable
                          onDragStart={() => handleDragStart(task.id)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => handleDrop(task.id)}
                          style={{
                            border: `1px solid ${isDone ? '#198754' : '#ddd'}`,
                            borderRadius: '10px',
                            padding: '16px 18px',
                            marginBottom: '12px',
                            backgroundColor: isDone ? '#f0fff4' : '#fff',
                            cursor: 'grab',
                            boxShadow: draggedTaskId === task.id ? '0 0 0 2px #0d6efd' : isDone ? '0 0 0 2px rgba(25, 135, 84, 0.18)' : '0 0 0 1px rgba(0,0,0,0.04)',
                            transition: 'all 0.2s ease',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                                <strong style={{ fontSize: '18px' }}>{task.title}</strong>
                                <span style={{
                                  borderRadius: '999px',
                                  padding: '3px 8px',
                                  fontSize: '12px',
                                  backgroundColor: task.status === 'done' ? '#198754' : '#e9ecef',
                                  color: task.status === 'done' ? '#ffffff' : '#495057',
                                  fontWeight: 700,
                                }}>
                                  {task.status}
                                </span>
                              </div>
                              {task.description ? <p style={{ margin: '0 0 10px', color: '#555', lineHeight: 1.4 }}>{task.description}</p> : <p style={{ margin: '0 0 10px', color: '#999' }}>Brak opisu</p>}
                              <p style={{ margin: 0, fontSize: '12px', color: '#888' }}>ID zadania: {task.id}</p>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              <button
                                onClick={() => void handleToggleTaskStatus(task)}
                                disabled={task.status === 'done'}
                                style={{
                                  padding: '8px 12px',
                                  backgroundColor: task.status === 'done' ? '#198754' : '#0d6efd',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: '6px',
                                  cursor: task.status === 'done' ? 'default' : 'pointer',
                                  minWidth: '110px',
                                  opacity: task.status === 'done' ? 1 : 1,
                                  fontWeight: 700,
                                }}
                              >
                                {task.status === 'done' ? 'Zrobione' : 'Oznacz jako done'}
                              </button>

                              <button
                                onClick={() => void handleDeleteTask(task.id)}
                                style={{
                                  padding: '8px 12px',
                                  backgroundColor: '#dc3545',
                                  color: 'white',
                                  border: 'none',
                                  borderRadius: '6px',
                                  cursor: 'pointer',
                                  minWidth: '110px',
                                }}
                              >
                                Usuń
                              </button>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  {tasks.length === 0 && <p>Brak zadań. Dodaj pierwsze zadanie!</p>}
                </section>
              </div>
            )}
          </div>
        )}
      </div>
    </ReactKeycloakProvider>
  );
}

export default App;
