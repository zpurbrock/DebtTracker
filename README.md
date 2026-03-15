# DebtTracker

App para control de deudas y pagos con gráficas.

## Stack
- Node.js + Express (servidor estático)
- HTML/CSS/JS vanilla (sin framework)
- Chart.js (gráficas)
- localStorage (persistencia de datos en el navegador)

## Desarrollo local

```bash
npm install
npm run dev        # con nodemon (auto-reload)
# ó
npm start          # producción
```

Abre http://localhost:3000

## Deploy en Railway

1. Sube el repositorio a GitHub
2. En Railway → New Project → Deploy from GitHub
3. Selecciona este repo
4. Railway detecta automáticamente Node.js y usa `npm start`
5. La variable `PORT` es asignada automáticamente por Railway

## Estructura

```
debt-tracker/
├── server.js          # Servidor Express
├── package.json
├── .gitignore
├── README.md
└── public/
    └── index.html     # App completa (HTML + CSS + JS)
```

## Próximos pasos sugeridos para Claude Code

- Agregar base de datos (PostgreSQL en Railway) para persistencia real
- Autenticación de usuarios
- Exportar datos a Excel/CSV
- Notificaciones de pagos próximos
- Multi-usuario / multi-organización
