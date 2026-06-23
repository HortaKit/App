"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import mqtt from "mqtt";
import {
  ComposedChart,
  Line,
  XAxis,
  Tooltip,
  ResponsiveContainer,
  YAxis,
  ReferenceArea,
} from "recharts";

const MQTT_WS_URL = process.env.NEXT_PUBLIC_MQTT_URL || "";
const MQTT_USER = process.env.NEXT_PUBLIC_MQTT_USER || "";
const MQTT_PASS = process.env.NEXT_PUBLIC_MQTT_PASS || "";

// Máximo de pontos mantidos por aparelho no histórico (evita crescimento ilimitado)
const MAX_HISTORY_POINTS = 200;

interface RecordHistory {
  rawTime: number;
  timestamp: string;
  umidade: number;
  bomba: number;
}

interface Dispositivo {
  id: string;
  nome: string;
  umidade: number;
  bomba: boolean;
  status: "Online" | "Offline";
  lastSeen: string;
  historico?: RecordHistory[];
}

// ─── Heurísticas ─────────────────────────────────────────────────────────────

interface Alerta {
  tipo: "encharcado" | "sem_agua" | "ok";
  mensagem: string;
}

function calcularAlertas(historico: RecordHistory[] | undefined): Alerta[] {
  if (!historico || historico.length < 6) return [];

  const alertas: Alerta[] = [];
  const recente = historico.slice(-30);

  const valores = recente.map((r) => r.umidade);
  const min = Math.min(...valores);
  const max = Math.max(...valores);
  const variacao = max - min;

  // Solo encharcado: umidade muito baixa E constante (sensor resistivo: baixo = molhado)
  const mediaUmidade = valores.reduce((a, b) => a + b, 0) / valores.length;
  const bombaLigadaCount = recente.filter((r) => r.bomba === 1).length;
  const propBombaLigada = bombaLigadaCount / recente.length;

  // Encharcado: leitura muito baixa (< 1200), pouca variação
  if (mediaUmidade < 1200 && variacao < 150) {
    alertas.push({
      tipo: "encharcado",
      mensagem: "Solo possivelmente encharcado — umidade muito alta e estável.",
    });
  }

  // Sem água: relé ligado por muito tempo mas umidade não varia nem cai
  // (sensor analógico: alto = seco; bomba ligada mas leitura não muda = sem água)
  if (propBombaLigada > 0.6 && variacao < 100 && mediaUmidade > 2800) {
    alertas.push({
      tipo: "sem_agua",
      mensagem: "Possível falta de água — bomba ativa mas solo não reagindo.",
    });
  }

  return alertas;
}

// ─── Processamento do gráfico (memoizado fora do render) ──────────────────────

interface ChartPoint {
  idx: number;
  timestamp: string;
  umidade: number;
  bomba: number;
}

function processarHistorico(historico: RecordHistory[]): {
  pontos: ChartPoint[];
  intervalosLigada: { start: number; end: number }[];
} {
  // Limita a 150 pontos para o gráfico, decimando se necessário
  let dados = historico;
  if (dados.length > 150) {
    const step = Math.ceil(dados.length / 150);
    dados = dados.filter((_, i) => i % step === 0);
    // Garante que o último ponto sempre aparece
    if (dados[dados.length - 1] !== historico[historico.length - 1]) {
      dados = [...dados, historico[historico.length - 1]];
    }
  }

  const pontos: ChartPoint[] = dados.map((d, i) => ({
    idx: i,
    timestamp: d.timestamp,
    umidade: d.umidade,
    bomba: d.bomba,
  }));

  // Calcula intervalos contínuos onde bomba === 1 para ReferenceArea
  const intervalos: { start: number; end: number }[] = [];
  let inicio: number | null = null;

  for (let i = 0; i < pontos.length; i++) {
    if (pontos[i].bomba === 1 && inicio === null) {
      inicio = i;
    } else if (pontos[i].bomba === 0 && inicio !== null) {
      intervalos.push({ start: inicio, end: i - 1 });
      inicio = null;
    }
  }
  if (inicio !== null) {
    intervalos.push({ start: inicio, end: pontos.length - 1 });
  }

  return { pontos, intervalosLigada: intervalos };
}

// ─── Componente do Gráfico (isolado para evitar re-renders desnecessários) ───

const GraficoUmidade = ({
  historico,
  isDarkMode,
}: {
  historico: RecordHistory[];
  isDarkMode: boolean;
}) => {
  const { pontos, intervalosLigada } = useMemo(
    () => processarHistorico(historico),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historico.length, historico[historico.length - 1]?.rawTime],
  );

  const axisColor = isDarkMode ? "#475569" : "#94a3b8";
  const tooltipBg = isDarkMode ? "#0f172a" : "#ffffff";
  const tooltipBorder = isDarkMode ? "#1e293b" : "#e2e8f0";

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart
        data={pontos}
        margin={{ top: 4, right: 8, left: -16, bottom: 0 }}
      >
        <XAxis
          dataKey="timestamp"
          stroke={axisColor}
          fontSize={10}
          tickMargin={8}
          minTickGap={30}
          interval="preserveStartEnd"
        />
        <YAxis
          stroke={axisColor}
          fontSize={10}
          domain={["auto", "auto"]}
          width={48}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: tooltipBg,
            borderColor: tooltipBorder,
            borderRadius: "8px",
            fontSize: "12px",
          }}
          formatter={(value: number, name: string) => {
            if (name === "umidade") return [value, "Umidade"];
            return [value === 1 ? "Ligada" : "Desligada", "Bomba"];
          }}
          labelFormatter={(label) => `⏱ ${label}`}
        />

        {/* Faixas de fundo: bomba ligada = verde, restante = azul sutil */}
        {intervalosLigada.map((iv, i) => (
          <ReferenceArea
            key={i}
            x1={iv.start}
            x2={iv.end}
            fill="#10b981"
            fillOpacity={0.12}
            strokeOpacity={0}
          />
        ))}

        {/* Linha única de umidade — sem bifurcação, cor sólida e confiável */}
        <Line
          type="monotone"
          dataKey="umidade"
          stroke="#0ea5e9"
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 5, fill: "#0ea5e9" }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
};

// ─── Componente dos Alertas ───────────────────────────────────────────────────

const BadgeAlertas = ({ alertas }: { alertas: Alerta[] }) => {
  if (alertas.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 mt-3">
      {alertas.map((a, i) => (
        <div
          key={i}
          className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs font-medium ${
            a.tipo === "encharcado"
              ? "bg-sky-500/10 text-sky-400 border border-sky-500/20"
              : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
          }`}
        >
          <span className="mt-0.5 shrink-0">
            {a.tipo === "encharcado" ? "💧" : "⚠️"}
          </span>
          {a.mensagem}
        </div>
      ))}
    </div>
  );
};

// ─── Dashboard principal ──────────────────────────────────────────────────────

export default function Dashboard() {
  const [registeredDevices, setRegisteredDevices] = useState<{
    [id: string]: Dispositivo;
  }>({});
  const [discoveredDevices, setDiscoveredDevices] = useState<{
    [id: string]: number;
  }>({});

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState("");
  const [modalNameInput, setModalNameInput] = useState("");

  const [isPairingOpen, setIsPairingOpen] = useState(false);
  const [idToRemove, setIdToRemove] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState<boolean | null>(null);

  const [mqttClient, setMqttClient] = useState<mqtt.MqttClient | null>(null);

  // Ref para evitar closures velhos dentro do handler MQTT
  const registeredDevicesRef = useRef(registeredDevices);
  useEffect(() => {
    registeredDevicesRef.current = registeredDevices;
  }, [registeredDevices]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    setIsDarkMode(mediaQuery.matches);
    const handleChange = (e: MediaQueryListEvent) => setIsDarkMode(e.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    const cached = localStorage.getItem("dispositivos");
    if (cached) {
      const parsed = JSON.parse(cached);
      const initializedOffline = Object.keys(parsed).reduce(
        (acc, id) => {
          acc[id] = { ...parsed[id], status: "Offline" };
          return acc;
        },
        {} as { [id: string]: Dispositivo },
      );
      setRegisteredDevices(initializedOffline);
    }

    if (!MQTT_WS_URL || !MQTT_USER || !MQTT_PASS) {
      console.error("Variáveis MQTT ausentes.");
      return;
    }

    const client = mqtt.connect(MQTT_WS_URL, {
      clientId: "next_edge_hub_" + Math.random().toString(16).substring(2, 10),
      username: MQTT_USER,
      password: MQTT_PASS,
      protocol: "wss",
      path: "/mqtt",
      protocolVersion: 4,
      clean: true,
      keepalive: 60,
      connectTimeout: 10000,
    });

    client.on("connect", () => {
      client.subscribe("dispositivos/+/telemetria");
      client.subscribe("dispositivos/+/historico");
    });

    client.on("message", (topic, message) => {
      const parts = topic.split("/");
      const deviceId = parts[1];
      const category = parts[2];
      const payload = message.toString();

      // ── Histórico binário ──────────────────────────────────────────
      if (category === "historico") {
        try {
          const view = new DataView(
            message.buffer,
            message.byteOffset,
            message.byteLength,
          );
          const records: RecordHistory[] = [];
          const recordSize = 7;

          for (let i = 0; i + recordSize <= view.byteLength; i += recordSize) {
            const timestamp = view.getUint32(i, true);
            const umidade = view.getUint16(i + 4, true);
            const bomba = view.getUint8(i + 6);
            records.push({
              rawTime: timestamp,
              timestamp: new Date(timestamp * 1000).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              }),
              umidade,
              bomba,
            });
          }

          records.sort((a, b) => a.rawTime - b.rawTime);

          // Limita pelo máximo configurado
          const limitados = records.slice(-MAX_HISTORY_POINTS);

          setRegisteredDevices((prev) => {
            if (!prev[deviceId]) return prev;
            return {
              ...prev,
              [deviceId]: { ...prev[deviceId], historico: limitados },
            };
          });
        } catch (error) {
          console.error("Erro parse histórico binário:", error);
        }
        return;
      }

      // ── Telemetria ─────────────────────────────────────────────────
      if (payload === "OFFLINE") {
        setRegisteredDevices((prev) => {
          if (!prev[deviceId]) return prev;
          return {
            ...prev,
            [deviceId]: { ...prev[deviceId], status: "Offline" },
          };
        });
        return;
      }

      if (payload.includes("D:") && payload.includes(",R:")) {
        const umidade = parseInt(payload.split("D:")[1].split(",R:")[0]);
        const bomba = payload.split(",R:")[1].trim() === "1";

        setRegisteredDevices((prev) => {
          if (!prev[deviceId]) return prev;
          return {
            ...prev,
            [deviceId]: {
              ...prev[deviceId],
              umidade,
              bomba,
              status: "Online",
              lastSeen: new Date().toLocaleTimeString(),
            },
          };
        });

        setDiscoveredDevices((prev) => ({ ...prev, [deviceId]: umidade }));
      } else {
        // Payload desconhecido mas dispositivo respondeu — marca online
        setRegisteredDevices((prev) => {
          if (!prev[deviceId]) return prev;
          return {
            ...prev,
            [deviceId]: {
              ...prev[deviceId],
              status: "Online",
              lastSeen: new Date().toLocaleTimeString(),
            },
          };
        });
      }
    });

    setMqttClient(client);
    return () => {
      client.end();
    };
  }, []);

  const handleOpenControlModal = (id: string) => {
    setSelectedId(id);
    if (registeredDevices[id]) setModalNameInput(registeredDevices[id].nome);
  };

  const handleRegisterDevice = (id: string) => {
    const finalName = pendingName.trim() || `Node (${id})`;
    const newDevice: Dispositivo = {
      id,
      nome: finalName,
      umidade: discoveredDevices[id] || 0,
      bomba: false,
      status: "Online",
      lastSeen: new Date().toLocaleTimeString(),
    };
    const updated = { ...registeredDevices, [id]: newDevice };
    setRegisteredDevices(updated);
    localStorage.setItem("dispositivos", JSON.stringify(updated));
    setPendingName("");
    setIsPairingOpen(false);
  };

  const handleRenameDevice = (id: string, newName: string) => {
    setModalNameInput(newName);
    if (!newName.trim()) return;
    setRegisteredDevices((prev) => {
      const updated = { ...prev, [id]: { ...prev[id], nome: newName.trim() } };
      localStorage.setItem("dispositivos", JSON.stringify(updated));
      return updated;
    });
  };

  const handleRemoveDevice = () => {
    if (!idToRemove) return;
    const copy = { ...registeredDevices };
    delete copy[idToRemove];
    setRegisteredDevices(copy);
    localStorage.setItem("dispositivos", JSON.stringify(copy));
    if (selectedId === idToRemove) setSelectedId(null);
    setIdToRemove(null);
  };

  const handleTogglePump = useCallback(
    (id: string, currentState: boolean) => {
      if (!mqttClient) return;
      mqttClient.publish(
        `dispositivos/${id}/comando`,
        currentState ? "CMD:PMP_0" : "CMD:PMP_1",
      );
    },
    [mqttClient],
  );

  const sortedDevices = useMemo(
    () =>
      Object.values(registeredDevices).sort((a, b) => {
        if (a.status === b.status) return a.nome.localeCompare(b.nome);
        return a.status === "Online" ? -1 : 1;
      }),
    [registeredDevices],
  );

  const sortedModalIds = useMemo(
    () =>
      Object.keys(discoveredDevices).sort((a, b) => {
        const aR = !!registeredDevices[a];
        const bR = !!registeredDevices[b];
        if (aR === bR) return a.localeCompare(b);
        return aR ? 1 : -1;
      }),
    [discoveredDevices, registeredDevices],
  );

  const activeDevice = selectedId ? registeredDevices[selectedId] : null;

  if (isDarkMode === null) {
    return <div className="min-h-screen bg-slate-900" />;
  }

  return (
    <div
      className={`min-h-screen font-sans antialiased transition-colors duration-200 ${
        isDarkMode
          ? "bg-slate-950 text-slate-100"
          : "bg-slate-50 text-slate-800"
      }`}
    >
      <main className="p-4 sm:p-8 max-w-7xl mx-auto">
        {/* ── Header ─────────────────────────────────────────────────── */}
        <header
          className={`mb-8 border-b pb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 ${
            isDarkMode ? "border-slate-800" : "border-slate-200"
          }`}
        >
          <div>
            <h1
              className={`text-2xl sm:text-3xl font-black flex items-center gap-2 ${
                isDarkMode ? "text-white" : "text-slate-900"
              }`}
            >
              Minhas Plantações{" "}
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            </h1>
            <p
              className={
                isDarkMode ? "text-slate-400 text-sm" : "text-slate-500 text-sm"
              }
            >
              Gerenciamento e monitoramento em tempo real
            </p>
          </div>
          <button
            onClick={() => setIsPairingOpen(true)}
            className="bg-emerald-600 hover:cursor-pointer hover:bg-emerald-700 text-white font-bold py-2.5 px-5 rounded-xl text-sm transition-all active:scale-95 shadow-md shadow-emerald-600/10"
          >
            Adicionar Dispositivo
          </button>
        </header>

        {/* ── Lista de dispositivos ───────────────────────────────────── */}
        {sortedDevices.length === 0 ? (
          <div
            className={`border-2 border-dashed rounded-3xl p-12 text-center max-w-xl mx-auto mt-12 shadow-sm ${
              isDarkMode
                ? "bg-slate-900/40 border-slate-800"
                : "bg-white border-slate-200"
            }`}
          >
            <span className="text-4xl block mb-3">📡</span>
            <h3
              className={`text-lg font-bold ${isDarkMode ? "text-slate-300" : "text-slate-700"}`}
            >
              Nenhum dispositivo registrado
            </h3>
            <p className="text-sm text-slate-500 mt-1">
              Utilize "Adicionar Dispositivo" para iniciar o monitoramento.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {sortedDevices.map((disp) => {
              const alertas = calcularAlertas(disp.historico);

              return (
                <div
                  key={disp.id}
                  className={`border rounded-2xl p-5 transition-all duration-300 shadow-sm flex flex-col lg:flex-row gap-6 ${
                    isDarkMode
                      ? disp.status === "Online"
                        ? "bg-slate-900/60 border-slate-800"
                        : "border-slate-900 bg-slate-950/40 opacity-60"
                      : disp.status === "Online"
                        ? "bg-white border-slate-200"
                        : "border-slate-200 bg-slate-100/60 opacity-60"
                  }`}
                >
                  {/* ── Painel lateral esquerdo ──────────────────────── */}
                  <div
                    className="w-full lg:w-1/3 flex flex-col cursor-pointer"
                    onClick={() => handleOpenControlModal(disp.id)}
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div>
                        <h3
                          className={`font-bold text-lg mb-1 ${isDarkMode ? "text-slate-200" : "text-slate-900"}`}
                        >
                          {disp.nome}
                        </h3>
                        <span className="text-xs text-slate-400 block font-mono">
                          UUID: {disp.id}
                        </span>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
                          disp.status === "Online"
                            ? isDarkMode
                              ? "bg-emerald-500/10 text-emerald-400"
                              : "bg-emerald-50 text-emerald-600 border border-emerald-100"
                            : isDarkMode
                              ? "bg-slate-800 text-slate-500"
                              : "bg-slate-200 text-slate-500"
                        }`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            disp.status === "Online"
                              ? "bg-emerald-500 animate-pulse"
                              : "bg-slate-400"
                          }`}
                        />
                        {disp.status}
                      </span>
                    </div>

                    {/* Métricas */}
                    <div
                      className={`grid grid-cols-2 gap-3 rounded-xl p-3 text-center border ${
                        isDarkMode
                          ? "bg-slate-950/40 border-slate-800/30"
                          : "bg-slate-50 border-slate-100"
                      }`}
                    >
                      <div>
                        <span className="text-[10px] text-slate-400 block uppercase tracking-wider font-semibold mb-0.5">
                          Leitura Atual
                        </span>
                        <strong
                          className={`text-sm ${
                            disp.status === "Offline"
                              ? "text-slate-400"
                              : disp.umidade > 3200
                                ? "text-amber-500"
                                : "text-sky-500"
                          }`}
                        >
                          {disp.status === "Online" && disp.umidade >= 0
                            ? `${disp.umidade}`
                            : "--"}
                        </strong>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 block uppercase tracking-wider font-semibold mb-0.5">
                          Bomba
                        </span>
                        <strong
                          className={`text-sm ${
                            disp.status === "Online" && disp.bomba
                              ? "text-emerald-500"
                              : "text-slate-400"
                          }`}
                        >
                          {disp.status === "Online"
                            ? disp.bomba
                              ? "Ativa"
                              : "Inativa"
                            : "--"}
                        </strong>
                      </div>
                    </div>

                    {/* Indicador de bomba com legenda de cores */}
                    <div className="flex items-center gap-4 mt-3 px-1">
                      <span className="flex items-center gap-1.5 text-[10px] text-slate-400">
                        <span className="w-3 h-1.5 rounded-sm bg-sky-500 inline-block opacity-80" />
                        Bomba desligada
                      </span>
                      <span className="flex items-center gap-1.5 text-[10px] text-slate-400">
                        <span className="w-3 h-1.5 rounded-sm bg-emerald-500 inline-block opacity-80" />
                        Bomba ligada
                      </span>
                    </div>

                    {/* Alertas heurísticos */}
                    <BadgeAlertas alertas={alertas} />
                  </div>

                  {/* ── Gráfico direita ──────────────────────────────── */}
                  <div
                    className={`w-full lg:w-2/3 border-t lg:border-t-0 lg:border-l pt-6 lg:pt-0 lg:pl-6 flex flex-col ${
                      isDarkMode ? "border-slate-800" : "border-slate-200"
                    }`}
                  >
                    <h4
                      className={`text-xs font-bold uppercase tracking-wider mb-3 ${
                        isDarkMode ? "text-slate-400" : "text-slate-500"
                      }`}
                    >
                      Umidade × Tempo
                      {disp.historico && disp.historico.length > 0 && (
                        <span className="ml-2 font-normal normal-case text-slate-500">
                          ({disp.historico.length} pontos)
                        </span>
                      )}
                    </h4>

                    {disp.historico && disp.historico.length > 0 ? (
                      <GraficoUmidade
                        historico={disp.historico}
                        isDarkMode={isDarkMode}
                      />
                    ) : (
                      <div className="flex-1 min-h-[220px] flex items-center justify-center text-xs text-slate-500 italic">
                        Aguardando dados históricos do broker…
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* ── Modal: Controle do aparelho ──────────────────────────────────── */}
      {selectedId && activeDevice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm">
          <div
            className={`w-full max-w-md rounded-2xl p-6 shadow-2xl border ${
              isDarkMode
                ? "bg-slate-900 border-slate-800 text-slate-100"
                : "bg-white border-slate-200 text-slate-800"
            }`}
          >
            <div
              className={`flex justify-between items-center mb-6 border-b pb-4 ${
                isDarkMode ? "border-slate-800" : "border-slate-100"
              }`}
            >
              <div>
                <h2
                  className={`text-xl font-black truncate max-w-[280px] ${isDarkMode ? "text-white" : "text-slate-900"}`}
                >
                  {activeDevice.nome}
                </h2>
                <p className="text-[10px] text-slate-400 font-mono">
                  Hardware UID: {activeDevice.id}
                </p>
              </div>
              <button
                onClick={() => setSelectedId(null)}
                className={`w-8 h-8 rounded-full hover:cursor-pointer flex items-center justify-center font-bold transition-colors ${
                  isDarkMode
                    ? "bg-slate-800 hover:bg-slate-700 text-slate-400"
                    : "bg-slate-100 hover:bg-slate-200 text-slate-500"
                }`}
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              {/* Renomear */}
              <div
                className={`border p-4 rounded-xl ${isDarkMode ? "bg-slate-950/40 border-slate-800" : "bg-slate-50 border-slate-100"}`}
              >
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                  Renomear Identificação
                </h4>
                <input
                  type="text"
                  value={modalNameInput}
                  onChange={(e) =>
                    handleRenameDevice(activeDevice.id, e.target.value)
                  }
                  className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500 transition-colors ${
                    isDarkMode
                      ? "bg-slate-900 border-slate-800 text-white"
                      : "bg-white border-slate-200 text-slate-800"
                  }`}
                  placeholder="Defina um nome para o aparelho..."
                />
              </div>

              {/* Dados do sensor */}
              <div
                className={`border p-4 rounded-xl flex justify-between items-center ${
                  isDarkMode
                    ? "bg-slate-950/40 border-slate-800"
                    : "bg-slate-50 border-slate-100"
                }`}
              >
                <div>
                  <span className="text-xs text-slate-400 block font-semibold">
                    Leitura de Umidade
                  </span>
                  <span
                    className={`text-xl font-black ${isDarkMode ? "text-white" : "text-slate-900"}`}
                  >
                    {activeDevice.status === "Online"
                      ? activeDevice.umidade
                      : "--"}
                  </span>
                </div>
                <span
                  className={`px-2.5 py-1 rounded-md text-xs font-bold ${
                    activeDevice.status === "Offline"
                      ? "bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                      : activeDevice.umidade > 3200
                        ? "bg-amber-100 text-amber-700"
                        : "bg-sky-100 text-sky-700"
                  }`}
                >
                  {activeDevice.status === "Offline"
                    ? "Aparelho Desconectado"
                    : activeDevice.umidade > 3200
                      ? "Solo Crítico"
                      : "Solo Estabilizado"}
                </span>
              </div>

              {/* Controle do relé */}
              <div
                className={`border p-4 rounded-xl ${isDarkMode ? "bg-slate-950/40 border-slate-800" : "bg-slate-50 border-slate-100"}`}
              >
                <div className="flex justify-between items-center mb-3">
                  <span className="text-xs text-slate-400 font-semibold">
                    Estado do Relé Acionador
                  </span>
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-bold ${
                      activeDevice.status === "Offline"
                        ? "bg-slate-200 text-slate-500 dark:bg-slate-800"
                        : activeDevice.bomba
                          ? "bg-emerald-100 text-emerald-700 animate-pulse"
                          : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {activeDevice.status === "Offline"
                      ? "Indisponível"
                      : activeDevice.bomba
                        ? "FLUXO ABERTO"
                        : "FLUXO FECHADO"}
                  </span>
                </div>

                <div className="flex gap-2">
                  <button
                    disabled={
                      activeDevice.bomba || activeDevice.status === "Offline"
                    }
                    onClick={() => handleTogglePump(activeDevice.id, false)}
                    className={`flex-1 hover:cursor-pointer py-2.5 rounded-xl font-bold text-xs transition-all text-white ${
                      activeDevice.bomba || activeDevice.status === "Offline"
                        ? "bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed opacity-40"
                        : "bg-emerald-600 hover:bg-emerald-700 active:scale-95 shadow-sm"
                    }`}
                  >
                    {activeDevice.status === "Offline"
                      ? "Nó Offline"
                      : activeDevice.bomba
                        ? "Comando Bloqueado"
                        : "Abrir Fluxo"}
                  </button>
                  <button
                    disabled={activeDevice.status === "Offline"}
                    onClick={() => handleTogglePump(activeDevice.id, true)}
                    className={`flex-1 hover:cursor-pointer py-2.5 rounded-xl font-bold text-xs transition-all text-white shadow-sm ${
                      activeDevice.status === "Offline"
                        ? "bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed opacity-40"
                        : "bg-rose-600 hover:bg-rose-700 active:scale-95"
                    }`}
                  >
                    Interromper Fluxo
                  </button>
                </div>
              </div>
            </div>

            <div
              className={`border-t pt-4 mt-6 ${isDarkMode ? "border-slate-800" : "border-slate-100"}`}
            >
              <button
                onClick={() => setIdToRemove(activeDevice.id)}
                className="w-full hover:cursor-pointer py-2 bg-transparent hover:bg-rose-50 dark:hover:bg-rose-950/20 text-rose-600 text-xs rounded-xl transition-all font-bold"
              >
                Remover Aparelho do Painel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Adicionar aparelho ─────────────────────────────────────── */}
      {isPairingOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm">
          <div
            className={`w-full max-w-md p-6 rounded-2xl shadow-2xl border ${
              isDarkMode
                ? "bg-slate-900 border-slate-800 text-slate-100"
                : "bg-white border-slate-200 text-slate-800"
            }`}
          >
            <div className="flex justify-between items-center mb-4">
              <h3
                className={`text-sm font-bold uppercase tracking-widest ${isDarkMode ? "text-white" : "text-slate-900"}`}
              >
                Dispositivos Encontrados
              </h3>
              <button
                onClick={() => setIsPairingOpen(false)}
                className="text-slate-400 hover:cursor-pointer hover:text-slate-600 font-bold"
              >
                ✕
              </button>
            </div>

            {sortedModalIds.length === 0 ? (
              <div className="py-6 text-center text-slate-400 text-xs">
                Procurando por dispositivos na rede…
              </div>
            ) : (
              <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                {sortedModalIds.map((id) => {
                  const existingDevice = registeredDevices[id];
                  const isRegistered = !!existingDevice;

                  return (
                    <div
                      key={id}
                      className={`border p-3 rounded-xl transition-all ${
                        isDarkMode
                          ? isRegistered
                            ? "bg-slate-950 border-slate-800/40 opacity-40"
                            : "bg-slate-950 border-slate-800 border-l-4 border-l-emerald-500"
                          : isRegistered
                            ? "bg-slate-50 border-slate-100 opacity-50"
                            : "bg-slate-50 border-slate-200 border-l-4 border-l-emerald-500"
                      }`}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <div>
                          <h4
                            className={`text-xs font-bold ${isDarkMode ? "text-slate-200" : "text-slate-800"}`}
                          >
                            {isRegistered
                              ? existingDevice.nome
                              : "Novo Aparelho Detectado"}
                          </h4>
                          <p className="text-[10px] text-slate-400 font-mono">
                            UUID: {id}
                          </p>
                        </div>
                        {isRegistered && (
                          <span className="text-[9px] font-black text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                            VINCULADO
                          </span>
                        )}
                      </div>

                      <div className="mt-3 flex gap-2">
                        <input
                          type="text"
                          placeholder={
                            isRegistered
                              ? "Provisionado"
                              : "Identificador (Ex: Canteiro A)"
                          }
                          disabled={isRegistered}
                          value={
                            isRegistered ? existingDevice.nome : pendingName
                          }
                          onChange={(e) => setPendingName(e.target.value)}
                          className={`flex-1 border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-emerald-500 disabled:cursor-not-allowed ${
                            isDarkMode
                              ? "bg-slate-900 border-slate-800 text-white disabled:opacity-40"
                              : "bg-white border-slate-200 text-slate-800 disabled:bg-slate-100"
                          }`}
                        />
                        <button
                          onClick={() =>
                            !isRegistered && handleRegisterDevice(id)
                          }
                          disabled={isRegistered}
                          className={`font-bold hover:cursor-pointer text-xs px-3 rounded-lg transition-all ${
                            isRegistered
                              ? "bg-slate-200 text-slate-400"
                              : "bg-emerald-600 hover:bg-emerald-700 text-white active:scale-95"
                          }`}
                        >
                          Adicionar
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Modal: Confirmar remoção ──────────────────────────────────────── */}
      {idToRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-sm">
          <div
            className={`w-full max-w-sm p-6 rounded-2xl shadow-2xl text-center border ${
              isDarkMode
                ? "bg-slate-900 border-slate-800 text-slate-100"
                : "bg-white border-slate-200 text-slate-800"
            }`}
          >
            <span className="text-2xl block mb-2">⚠️</span>
            <h4 className="text-base font-black">Remover Aparelho?</h4>
            <p className="text-xs text-slate-400 mt-2 mb-6">
              O módulo{" "}
              <span className="font-mono text-emerald-500 font-bold">
                {registeredDevices[idToRemove]?.nome}
              </span>{" "}
              será desvinculado deste terminal de controle.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setIdToRemove(null)}
                className={`flex-1 py-2 hover:cursor-pointer border rounded-xl text-xs font-bold transition-all ${
                  isDarkMode
                    ? "bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300"
                    : "bg-slate-100 hover:bg-slate-200 border-slate-200 text-slate-600"
                }`}
              >
                Cancelar
              </button>
              <button
                onClick={handleRemoveDevice}
                className="flex-1 py-2 hover:cursor-pointer bg-rose-600 hover:bg-rose-700 rounded-xl text-xs font-bold transition-all text-white shadow-md shadow-rose-600/10"
              >
                Confirmar Exclusão
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
