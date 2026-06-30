export function App() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>AutoAgent</h1>
        <span>Local autonomous team console</span>
      </header>
      <section className="workspace-shell">
        <aside className="workspace-list" />
        <section className="console-region" />
      </section>
    </main>
  );
}
