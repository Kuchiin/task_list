# Docker Compose Project Checklist

## 1. Cel projektu
Multi-serwisowa aplikacja uruchamiana przez Docker Compose. Projekt obejmuje backend Node.js, frontend React, reverse proxy Nginx, bazy PostgreSQL oraz Keycloak jako serwer autoryzacji.

## 2. Architektura aplikacji

```
[Host / localhost]
    | 80
    V
[Nginx reverse proxy]
    | /api2/ -> backend:5000
    V
[Backend Node.js + Express]
    | DB connection
    V
[PostgreSQL tasks-db]

[Keycloak] <-> [Keycloak PostgreSQL]
[Frontend build artifact] jest serwowane przez Nginx
```

### Usługi i ich rola
| Usługa | Rola | Ekspozycja | Uwagi |
|---|---|---|---|
| `nginx` | reverse proxy i host statycznego frontendu | `80:80` | przekierowuje `/api2/` do backendu |
| `backend` | API Node.js/Express | `5000:5000` | endpointy `/health`, `/tasks`, `/tasks/:id` |
| `tasks-db` | PostgreSQL | wewnętrznie | dane aplikacji |
| `frontend` | build React + Nginx | wewnętrznie | pliki statyczne serwowane przez Nginx |
| `keycloak` | serwer autoryzacji | `8080:8080` | health endpoint `/health/ready` |
| `keycloak-db` | PostgreSQL dla Keycloak | wewnętrznie | magazyn danych Keycloak |

### Sieci i wolumeny
- Sieci: `public-net`, `internal-net`
- Wolumeny nazwane:
  - `tasks-data`
  - `keycloak-data`
  - `keycloak-db-data`

## 3. Wymagania środowiskowe
- Docker Desktop / Docker Engine
- Docker Compose
- PowerShell lub terminal z dostępem do `docker`

## 4. Uruchomienie projektu od zera

### 4.1 Sprawdzenie narzędzi
```powershell
docker --version
docker compose version
```

### 4.2 Zbudowanie i uruchomienie
W katalogu projektu:
```powershell
docker compose up -d --build
```

### 4.3 Sprawdzenie statusu kontenerów
```powershell
docker compose ps
```

### Oczekiwany wynik
Wszystkie kluczowe usługi powinny mieć status `Up (healthy)`:
- `backend`
- `frontend`
- `nginx`
- `keycloak`
- `tasks-db`
- `keycloak-db`

Przykładowy wynik:
```text
backend         Up (healthy)
frontend        Up (healthy)
nginx           Up (healthy)
keycloak        Up (healthy)
tasks-db        Up (healthy)
keycloak-db     Up (healthy)
```

### 4.4 Sprawdzenie zdrowia pojedynczych usług
```powershell
docker inspect --format '{{.Name}} {{.State.Health.Status}}' backend-1 frontend-1 nginx-1 keycloak-1
```

Oczekiwany wynik:
```text
healthy
healthy
healthy
healthy
```

## 5. Walidacja funkcjonalna

### 5.1 Backend health check
```powershell
Invoke-WebRequest -Uri http://localhost:5000/health -UseBasicParsing
```

Oczekiwany wynik JSON:
```json
{"status":"UP","database":"CONNECTED"}
```

### 5.2 Frontend / reverse proxy
```powershell
Invoke-WebRequest -Uri http://localhost/ -UseBasicParsing
```

Oczekiwany wynik:
- HTTP `200`
- HTML strony aplikacji

### 5.3 API przez proxy
```powershell
curl.exe -i http://localhost/api2/tasks
```

Oczekiwany wynik:
- HTTP `401 Unauthorized` bez tokena
- `200 OK` po poprawnym przesłaniu tokena Bearer

Po uzyskaniu tokena możesz sprawdzić endpoint przez proxy z nagłówkiem Bearer:
```powershell
curl.exe -i -H "Authorization: Bearer $token" http://localhost/api2/tasks
```

### 5.4 Pozyskaj token Bearer z Keycloak
Token ma krótką ważność (domyślnie 300s). Poniżej działające przykłady dla PowerShell (Windows) i Bash (Linux/macOS).

- PowerShell (zalecane przy prezentacji na Windows):

```powershell
# Pobierz i sparsuj token (jedna linia curl, potem ConvertFrom-Json)
$response = curl.exe -s -X POST "http://localhost:8080/realms/task-app-realm/protocol/openid-connect/token" -H "Content-Type: application/x-www-form-urlencoded" -d "grant_type=password&client_id=task-app-frontend&username=demo&password=demo123"
$token = ($response | ConvertFrom-Json).access_token
Write-Host "Token length: $($token.Length)"
```

- Bash (np. WSL, Git Bash, Linux):

```bash
TOKEN=$(curl -s -X POST "http://localhost:8080/realms/task-app-realm/protocol/openid-connect/token" -H "Content-Type: application/x-www-form-urlencoded" -d "grant_type=password&client_id=task-app-frontend&username=demo&password=demo123" | jq -r .access_token)
echo "Token length: ${#TOKEN}"
```

### 5.5 Tworzenie zadania z tokenem (curl)
Po uzyskaniu zmiennej `$token` lub `$TOKEN` możesz wysłać `curl` z nagłówkiem `Authorization`.

- PowerShell (wywołanie z `curl.exe`):

```powershell
# Preferred: PowerShell native (avoids quoting issues)
$body = @{ title='checklist-demo'; description='generated'; status='todo' } | ConvertTo-Json
Invoke-RestMethod -Uri http://localhost:5000/tasks -Method Post -Headers @{ Authorization = "Bearer $token" } -Body $body -ContentType 'application/json'
```

- Bash:

```bash
curl -i -X POST http://localhost:5000/tasks -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d '{"title":"checklist-demo","description":"generated","status":"todo"}'
```

Oczekiwany wynik po autoryzacji:

```json
{"id":1,"title":"checklist-demo","description":"generated","status":"todo"}
```

Uwaga o odświeżaniu tokena:

- PowerShell (jeżeli chcesz odświeżyć access token za pomocą `refresh_token`):

```powershell
$refresh = ($response | ConvertFrom-Json).refresh_token
$resp2 = curl.exe -s -X POST "http://localhost:8080/realms/task-app-realm/protocol/openid-connect/token" -H "Content-Type: application/x-www-form-urlencoded" -d "grant_type=refresh_token&client_id=task-app-frontend&refresh_token=$refresh"
$token = ($resp2 | ConvertFrom-Json).access_token
Write-Host "New token length: $($token.Length)"
```

- Bash:

```bash
REFRESH=$(echo "$RESPONSE" | jq -r .refresh_token)
NEW_TOKEN=$(curl -s -X POST "http://localhost:8080/realms/task-app-realm/protocol/openid-connect/token" -H "Content-Type: application/x-www-form-urlencoded" -d "grant_type=refresh_token&client_id=task-app-frontend&refresh_token=${REFRESH}" | jq -r .access_token)
echo "New token length: ${#NEW_TOKEN}"
```

### 5.6 Pobranie zadań z tokenem
```powershell
Invoke-WebRequest -Uri http://localhost:5000/tasks -Headers @{"Authorization"="Bearer $token"} -UseBasicParsing
```

Oczekiwany wynik po autoryzacji:
- HTTP `200`
- lista zawierająca utworzony rekord

### 5.6 Keycloak readiness
```powershell
curl.exe -i http://localhost:8080/health/ready
```

Oczekiwany wynik:
```json
{"status":"UP","checks":[]}
```

## 6. Kontrola konfiguracji i zasobów

### Przykładowe komendy diagnostyczne
```powershell
docker compose config --services
docker volume ls
docker network ls
```

### Oczekiwane zasoby
- wolumeny `tasks-data`, `keycloak-data`, `keycloak-db-data`
- sieci `public-net` i `internal-net`

## 7. Potwierdzone wyniki projektu
- `docker compose ps` pokazuje wszystkie przynajmniej kluczowe usługi jako `healthy`.
- `/health` backendu zwraca `UP` i informację o połączeniu z bazą.
- reverse proxy Nginx zwraca stronę frontendu i zwraca `401 Unauthorized` dla `/api2/tasks` bez tokena.
- tworzenie zadania przez API działa po autoryzacji.
- Keycloak odpowiada na readiness endpoint `/health/ready`.
- `frontend/.dockerignore` został dodany, aby ograniczyć kontekst builda.

## 8. Kluczowe pliki projektu
- `docker-compose.yml` — definicja całej infrastruktury
- `backend/server.js` — API i endpointy
- `backend/Dockerfile` — obraz backendu
- `frontend/Dockerfile` — obraz frontendu
- `frontend/.dockerignore` — optymalizacja build context
- `nginx/nginx.conf` — proxy i hostowanie frontendu
- `CHECKLIST.md` — zestaw instrukcji i wyników

## 9. Status końcowy
Projekt jest uruchamialny, zdrowy i możliwy do weryfikacji na lokalnym środowisku Docker Compose.

## 10. Szybki start (PowerShell)
```powershell
# 1. uruchom środowisko
 docker compose up -d --build

# 2. sprawdź status
 docker compose ps

# 3. sprawdź API
 curl.exe -i http://localhost:5000/health
 curl.exe -i http://localhost/

# 4. sprawdź Keycloak readiness
 curl.exe -i http://localhost:8080/health/ready
```
