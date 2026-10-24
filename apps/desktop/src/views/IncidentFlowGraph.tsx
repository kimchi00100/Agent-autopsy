import React, { useState, useRef } from 'react';
import { FlowNode, FlowEdge, IncidentFlowData } from '../api';
import {
  Folder,
  FileCode2,
  TestTube,
  Lightbulb,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ShieldAlert,
  Target,
  AlertTriangle,
  ShieldCheck,
  Activity,
  Layers,
  RotateCcw,
} from 'lucide-react';

interface Props {
  flowData: IncidentFlowData;
  onSelectNode?: (node: FlowNode) => void;
  onSelectEdge?: (edge: FlowEdge) => void;
}

export default function IncidentFlowGraph({ flowData, onSelectNode, onSelectEdge }: Props) {
  const [viewMode, setViewMode] = useState<'behavior' | 'file'>('behavior');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 20, y: 20 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  // Custom node positions allowing user to drag and drop nodes freely
  const [customPositions, setCustomPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [nodeDragOffset, setNodeDragOffset] = useState({ x: 0, y: 0 });

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // Layer filters
  const [filters, setFilters] = useState({
    fileChange: true,
    testFailure: true,
    causeCandidate: true,
    relatedLinks: true,
  });

  const containerRef = useRef<HTMLDivElement>(null);

  // Active nodes & edges based on viewMode
  const rawNodes = (viewMode === 'behavior' ? flowData.behaviorNodes : flowData.fileNodes) || flowData.nodes || [];
  const rawEdges = (viewMode === 'behavior' ? flowData.behaviorEdges : flowData.fileEdges) || flowData.edges || [];

  // Get effective position of a node (custom position or default)
  const getNodePos = (node: FlowNode) => {
    if (customPositions[node.id]) return customPositions[node.id];
    return { x: node.x, y: node.y };
  };

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.graph-node') || (e.target as HTMLElement).closest('.graph-edge')) return;
    setIsPanning(true);
    setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    const node = rawNodes.find((n) => n.id === nodeId);
    if (!node) return;
    const pos = getNodePos(node);
    setDraggingNodeId(nodeId);
    setNodeDragOffset({
      x: (e.clientX - pan.x) / zoom - pos.x,
      y: (e.clientY - pan.y) / zoom - pos.y,
    });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    } else if (draggingNodeId) {
      const newX = Math.round((e.clientX - pan.x) / zoom - nodeDragOffset.x);
      const newY = Math.round((e.clientY - pan.y) / zoom - nodeDragOffset.y);
      setCustomPositions((prev) => ({
        ...prev,
        [draggingNodeId]: { x: newX, y: newY },
      }));
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);
    setDraggingNodeId(null);
  };

  const handleZoom = (delta: number) => {
    setZoom((z) => Math.min(1.8, Math.max(0.5, Number((z + delta).toFixed(1)))));
  };

  const resetView = () => {
    setZoom(1);
    setPan({ x: 20, y: 20 });
  };

  const resetNodeLayout = () => {
    setCustomPositions({});
  };

  // Check if node is dimmed by filters (dimmed to 20% opacity instead of disappearing!)
  const isNodeDimmed = (node: FlowNode): boolean => {
    if (viewMode === 'file') {
      if (!filters.fileChange && (node.type === 'file' || node.status === 'modified')) return true;
      if (!filters.testFailure && (node.type === 'test_failure' || node.status === 'failure')) return true;
      if (!filters.causeCandidate && (node.type === 'cause_candidate' || node.status === 'candidate')) return true;
    }
    return false;
  };

  const isEdgeDimmed = (edge: FlowEdge): boolean => {
    const src = rawNodes.find((n) => n.id === edge.source);
    const tgt = rawNodes.find((n) => n.id === edge.target);
    if (src && isNodeDimmed(src)) return true;
    if (tgt && isNodeDimmed(tgt)) return true;
    if (!filters.relatedLinks && edge.color === 'gray') return true;
    return false;
  };

  const nodeMap = new Map(rawNodes.map((n) => [n.id, n]));

  return (
    <div
      ref={containerRef}
      onMouseDown={handleCanvasMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      className="canvas-grid relative h-[620px] w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-50/70 select-none cursor-grab active:cursor-grabbing"
    >
      {/* Top Left View Switcher & Layout Controls */}
      <div className="absolute left-4 top-4 z-10 flex items-center gap-3">
        {/* View Mode Toggle Button */}
        <div className="flex items-center rounded-lg border border-slate-200 bg-white/95 p-0.5 shadow-sm backdrop-blur">
          <button
            onClick={() => setViewMode('behavior')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              viewMode === 'behavior'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            <Activity className="h-3.5 w-3.5" />
            동작 추적 흐름도 (기본)
          </button>
          <button
            onClick={() => setViewMode('file')}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              viewMode === 'file'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            폴더·파일 구조도
          </button>
        </div>

        {/* Reset Custom Layout Button */}
        {Object.keys(customPositions).length > 0 && (
          <button
            onClick={resetNodeLayout}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/95 px-2.5 py-1.5 text-xs font-medium text-slate-600 shadow-sm hover:bg-slate-50 hover:text-blue-600 transition backdrop-blur"
            title="사용자가 이동한 노드 위치를 원래 기본 레이아웃으로 되돌립니다"
          >
            <RotateCcw className="h-3 w-3" />
            배치 초기화
          </button>
        )}

        {/* Legend */}
        <div className="flex items-center gap-4 rounded-lg border border-slate-200/90 bg-white/95 px-3 py-1.5 text-xs text-slate-600 shadow-sm backdrop-blur">
          {viewMode === 'behavior' ? (
            <>
              <span className="flex items-center gap-1.5 font-medium">
                <span className="inline-block w-3.5 border-b-2 border-blue-600" />
                관찰됨 (실선)
              </span>
              <span className="flex items-center gap-1.5 font-medium">
                <span className="inline-block w-3.5 border-b-2 border-dashed border-slate-400" />
                정적 추론 (점선)
              </span>
              <span className="flex items-center gap-1.5 font-medium">
                <span className="h-2 w-2 rounded-full bg-rose-500" />
                끊김 지점
              </span>
              <span className="flex items-center gap-1.5 font-medium">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                원인 후보
              </span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1.5 font-medium">
                <span className="h-2 w-2 rounded-full bg-blue-600" />
                수정된 파일
              </span>
              <span className="flex items-center gap-1.5 font-medium">
                <span className="h-2 w-2 rounded-full bg-rose-500" />
                테스트 실패
              </span>
              <span className="flex items-center gap-1.5 font-medium">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                원인 후보
              </span>
            </>
          )}
        </div>
      </div>

      {/* Canvas Workspace */}
      <div
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: '0 0',
          transition: isPanning || draggingNodeId ? 'none' : 'transform 0.1s ease-out',
        }}
        className="absolute inset-0 h-[2400px] w-[3200px] pointer-events-none"
      >
        <svg className="absolute inset-0 h-full w-full pointer-events-none">
          {rawEdges.map((edge) => {
            const src = nodeMap.get(edge.source);
            const tgt = nodeMap.get(edge.target);
            if (!src || !tgt) return null;

            const srcPos = getNodePos(src);
            const tgtPos = getNodePos(tgt);

            const isBehavior = viewMode === 'behavior';
            const nodeWidth = isBehavior ? 240 : 180;
            const nodeHeight = isBehavior ? 80 : 44;

            const srcX = srcPos.x + nodeWidth;
            const srcY = srcPos.y + nodeHeight / 2;
            const tgtX = tgtPos.x;
            const tgtY = tgtPos.y + nodeHeight / 2;
            const dx = Math.max(50, (tgtX - srcX) * 0.5);

            const pathD = `M ${srcX} ${srcY} C ${srcX + dx} ${srcY}, ${tgtX - dx} ${tgtY}, ${tgtX} ${tgtY}`;

            let strokeColor = '#94a3b8';
            if (edge.color === 'blue') strokeColor = '#2563eb';
            else if (edge.color === 'red') strokeColor = '#ef4444';
            else if (edge.color === 'orange') strokeColor = '#f97316';
            else if (edge.color === 'green') strokeColor = '#10b981';

            const midX = (srcX + tgtX) / 2;
            const midY = (srcY + tgtY) / 2 - 12; // Raised above curve
            const isSelected = selectedEdgeId === edge.id;
            const dimmed = isEdgeDimmed(edge);

            return (
              <g
                key={edge.id}
                className={`graph-edge pointer-events-auto cursor-pointer transition-opacity duration-200 ${
                  dimmed ? 'opacity-20 grayscale pointer-events-none' : ''
                }`}
                onClick={() => {
                  setSelectedEdgeId(edge.id);
                  setSelectedNodeId(null);
                  onSelectEdge?.(edge);
                }}
              >
                <path
                  d={pathD}
                  fill="none"
                  stroke={isSelected ? '#1d4ed8' : strokeColor}
                  strokeWidth={isSelected ? '3.5' : edge.isObserved ? '2.5' : '1.8'}
                  strokeDasharray={edge.style === 'dashed' ? '5 5' : undefined}
                  className="transition-all hover:stroke-blue-700"
                />
                <circle cx={tgtX} cy={tgtY} r={isSelected ? '4.5' : '3.5'} fill={strokeColor} />

                {/* Edge Label Badge in open space */}
                {edge.label && isBehavior && (
                  <g transform={`translate(${midX}, ${midY})`}>
                    <rect
                      x="-38"
                      y="-10"
                      width="76"
                      height="20"
                      rx="4"
                      fill="#ffffff"
                      stroke={edge.isObserved ? '#2563eb' : '#cbd5e1'}
                      strokeWidth="1"
                      className="shadow-sm"
                    />
                    <text
                      x="0"
                      y="4"
                      textAnchor="middle"
                      fill={edge.isObserved ? '#1d4ed8' : '#64748b'}
                      fontSize="10"
                      fontWeight="600"
                    >
                      {edge.label}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>

        {/* Nodes */}
        {rawNodes.map((node) => {
          const isSelected = selectedNodeId === node.id;
          const pos = getNodePos(node);
          const dimmed = isNodeDimmed(node);
          const isBehavior = viewMode === 'behavior';

          return (
            <div
              key={node.id}
              onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
              onClick={() => {
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
                onSelectNode?.(node);
              }}
              style={{
                left: pos.x,
                top: pos.y,
                width: isBehavior ? 240 : 180,
              }}
              className={`graph-node absolute pointer-events-auto cursor-move rounded-xl border bg-white shadow-sm transition-all duration-150 hover:shadow-md ${
                dimmed ? 'opacity-20 grayscale' : 'opacity-100'
              } ${isBehavior ? 'p-3' : 'px-3.5 py-2.5'} ${
                isSelected
                  ? 'ring-2 ring-blue-600 border-blue-500 shadow-md'
                  : node.type === 'requirement'
                  ? 'border-blue-300 bg-blue-50/40'
                  : node.type === 'broken_point'
                  ? 'border-rose-300 bg-rose-50/60 ring-1 ring-rose-400/40'
                  : node.type === 'test_failure'
                  ? 'border-rose-300 bg-rose-50/60'
                  : node.type === 'cause_candidate'
                  ? 'border-amber-300 bg-amber-50/60'
                  : node.type === 'verification'
                  ? 'border-emerald-300 bg-emerald-50/30'
                  : node.status === 'modified'
                  ? 'border-blue-200 bg-blue-50/20'
                  : 'border-slate-200'
              }`}
            >
              {/* File Structure Mode: Clean Compact Layout */}
              {!isBehavior ? (
                <div className="flex items-center gap-2">
                  {node.type === 'root' && <Folder className="h-4 w-4 text-blue-600 shrink-0" />}
                  {node.type === 'dir' && <Folder className="h-4 w-4 text-slate-500 shrink-0" />}
                  {node.type === 'file' && <FileCode2 className="h-4 w-4 text-blue-600 shrink-0" />}
                  {node.type === 'test_file' && <TestTube className="h-4 w-4 text-rose-500 shrink-0" />}
                  {node.type === 'test_failure' && <ShieldAlert className="h-4 w-4 text-rose-600 shrink-0" />}
                  {node.type === 'cause_candidate' && <Lightbulb className="h-4 w-4 text-amber-600 shrink-0" />}

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-slate-900">{node.label}</div>
                    {node.sublabel && <div className="truncate text-[10px] text-slate-400">{node.sublabel}</div>}
                  </div>

                  {node.diffBadge && (
                    <div className="ml-1 flex items-center gap-1 rounded bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium border border-slate-200 shrink-0">
                      <span className="text-emerald-600">+{node.diffBadge.added}</span>
                      <span className="text-rose-600">-{node.diffBadge.removed}</span>
                    </div>
                  )}
                </div>
              ) : (
                /* Behavior Flow Mode: Rich Step Information */
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5 shrink-0">
                    {node.type === 'requirement' && <Target className="h-4 w-4 text-blue-600" />}
                    {node.type === 'call_step' && <FileCode2 className="h-4 w-4 text-slate-700" />}
                    {node.type === 'broken_point' && <AlertTriangle className="h-4 w-4 text-rose-600" />}
                    {node.type === 'cause_candidate' && <Lightbulb className="h-4 w-4 text-amber-600" />}
                    {node.type === 'verification' && <ShieldCheck className="h-4 w-4 text-emerald-600" />}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="truncate text-xs font-semibold text-slate-900">{node.label}</span>
                      {node.isObserved !== undefined && (
                        <span
                          className={`text-[9px] px-1 py-0.5 rounded font-medium shrink-0 ${
                            node.isObserved
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-slate-100 text-slate-500 border border-slate-200'
                          }`}
                        >
                          {node.isObserved ? '관찰됨' : '추론됨'}
                        </span>
                      )}
                    </div>

                    {node.sublabel && (
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-slate-500 font-normal">
                        {node.sublabel}
                      </div>
                    )}

                    {/* 3-Level mini badge */}
                    {node.threeLevelStatus && (
                      <div className="mt-2 flex items-center gap-1 text-[9px] font-semibold">
                        <span
                          className={`px-1 py-0.5 rounded ${
                            node.threeLevelStatus.code === 'PASS'
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-rose-100 text-rose-700'
                          }`}
                        >
                          코드: {node.threeLevelStatus.code}
                        </span>
                        <span
                          className={`px-1 py-0.5 rounded ${
                            node.threeLevelStatus.functional === 'PASS'
                              ? 'bg-emerald-100 text-emerald-700'
                              : node.threeLevelStatus.functional === 'FAIL'
                              ? 'bg-rose-100 text-rose-700'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          기능: {node.threeLevelStatus.functional}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom Left Minimap Preview */}
      <div className="absolute bottom-4 left-4 z-10 h-24 w-36 overflow-hidden rounded-lg border border-slate-200 bg-white/95 p-1.5 shadow-sm backdrop-blur">
        <div className="relative h-full w-full rounded border border-dashed border-slate-200 bg-slate-50">
          {rawNodes.map((n) => {
            const pos = getNodePos(n);
            return (
              <div
                key={n.id}
                style={{ left: `${(pos.x / 1600) * 80}%`, top: `${(pos.y / 600) * 80}%` }}
                className={`absolute h-1.5 w-1.5 rounded-full ${
                  n.type === 'broken_point' || n.type === 'test_failure'
                    ? 'bg-rose-500'
                    : n.type === 'cause_candidate'
                    ? 'bg-amber-500'
                    : 'bg-blue-500'
                }`}
              />
            );
          })}
          <div className="absolute inset-2 border border-blue-400/60 bg-blue-500/5 rounded" />
        </div>
      </div>

      {/* Bottom Center Filters (Checked: Normal / Unchecked: Dimmed 20% instead of disappearing!) */}
      {viewMode === 'file' && (
        <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-4 rounded-xl border border-slate-200 bg-white/95 px-4 py-2 text-xs font-medium text-slate-700 shadow-sm backdrop-blur">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.fileChange}
              onChange={(e) => setFilters({ ...filters, fileChange: e.target.checked })}
              className="rounded text-blue-600 focus:ring-0"
            />
            <span className="h-2 w-2 rounded-full bg-blue-600" />
            파일 변경
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.testFailure}
              onChange={(e) => setFilters({ ...filters, testFailure: e.target.checked })}
              className="rounded text-rose-600 focus:ring-0"
            />
            <span className="h-2 w-2 rounded-full bg-rose-500" />
            테스트 실패
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.causeCandidate}
              onChange={(e) => setFilters({ ...filters, causeCandidate: e.target.checked })}
              className="rounded text-amber-600 focus:ring-0"
            />
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            원인 후보
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer text-slate-500">
            <input
              type="checkbox"
              checked={filters.relatedLinks}
              onChange={(e) => setFilters({ ...filters, relatedLinks: e.target.checked })}
              className="rounded text-slate-400 focus:ring-0"
            />
            관련 연결선
          </label>
        </div>
      )}

      {/* Bottom Right Zoom Controls */}
      <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1 rounded-xl border border-slate-200 bg-white/95 p-1 shadow-sm backdrop-blur">
        <button
          onClick={() => handleZoom(-0.1)}
          className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 transition"
          title="축소"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="px-2 text-xs font-semibold text-slate-700">{Math.round(zoom * 100)}%</span>
        <button
          onClick={() => handleZoom(0.1)}
          className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 transition"
          title="확대"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        <div className="mx-1 h-3.5 w-px bg-slate-200" />
        <button
          onClick={resetView}
          className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 transition"
          title="원래 크기"
        >
          <Maximize2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
