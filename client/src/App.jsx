import React, { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken, AuthError } from './api.js';
import Login from './views/Login.jsx';
import Home from './views/Home.jsx';
import Employee from './views/Employee.jsx';
import Summary from './views/Summary.jsx';

export default function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [config, setConfig] = useState({ shop_name: 'Ателье', vision_ready: true });
  const [weeks, setWeeks] = useState([]);
  const [weekId, setWeekId] = useState(null);
  // view: {name:'home'} | {name:'employee', employeeId} | {name:'summary', employeeId}
  const [view, setView] = useState({ name: 'home' });

  const handleError = useCallback((e) => {
    if (e instanceof AuthError) {
      setAuthed(false);
      return;
    }
    alert(e.message || 'Ошибка');
  }, []);

  const loadWeeks = useCallback(async () => {
    const list = await api('/api/weeks');
    setWeeks(list);
    setWeekId((cur) => {
      if (cur && list.some((w) => w.id === cur)) return cur;
      return list[0]?.id ?? null;
    });
    return list;
  }, []);

  useEffect(() => {
    if (!authed) return;
    (async () => {
      try {
        const cfg = await api('/api/config');
        setConfig(cfg);
        const list = await loadWeeks();
        if (list.length === 0) {
          await api('/api/weeks', { method: 'POST', body: {} });
          await loadWeeks();
        }
      } catch (e) {
        handleError(e);
      }
    })();
  }, [authed, loadWeeks, handleError]);

  if (!authed) {
    return (
      <Login
        onLogin={(token, cfg) => {
          setToken(token);
          setConfig((c) => ({ ...c, ...cfg }));
          setAuthed(true);
        }}
      />
    );
  }

  const week = weeks.find((w) => w.id === weekId) || null;

  if (view.name === 'employee' && week) {
    return (
      <Employee
        weekId={week.id}
        employeeId={view.employeeId}
        visionReady={config.vision_ready}
        onBack={() => setView({ name: 'home' })}
        onSummary={() => setView({ name: 'summary', employeeId: view.employeeId })}
        onError={handleError}
      />
    );
  }

  if (view.name === 'summary' && week) {
    return (
      <Summary
        weekId={week.id}
        employeeId={view.employeeId}
        shopName={config.shop_name}
        onBack={() => setView({ name: 'employee', employeeId: view.employeeId })}
        onError={handleError}
      />
    );
  }

  return (
    <Home
      weeks={weeks}
      weekId={weekId}
      onSelectWeek={setWeekId}
      onNewWeek={async () => {
        try {
          const w = await api('/api/weeks', { method: 'POST', body: {} });
          await loadWeeks();
          setWeekId(w.id);
        } catch (e) {
          handleError(e);
        }
      }}
      onDeleteWeek={async () => {
        try {
          await api(`/api/weeks/${weekId}`, { method: 'DELETE' });
          const list = await loadWeeks();
          if (list.length === 0) {
            // The app always has a current week to work in.
            await api('/api/weeks', { method: 'POST', body: {} });
            await loadWeeks();
          }
        } catch (e) {
          handleError(e);
        }
      }}
      onOpenEmployee={(employeeId) => setView({ name: 'employee', employeeId })}
      onError={handleError}
    />
  );
}
