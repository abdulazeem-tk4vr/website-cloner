'use client';

import { useState } from 'react';
import { Sandpack } from '@codesandbox/sandpack-react';

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [logs, setLogs] = useState<string[]>([]);
  
  const handleClone = async () => {
    if (!url) return;
    
    setLoading(true);
    setLogs([]);
    setResult(null);
    
    try {
      // Start clone request first to get jobId
      const response = await fetch('/api/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      
      const cloneData = await response.json();
      const jobId = cloneData.jobId || 'demo';
      
      // Connect to stream with actual jobId
      const eventSource = new EventSource(`/api/stream?jobId=${jobId}`);
      
      eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'log') {
          setLogs(prev => [...prev, `[${data.data.level.toUpperCase()}] ${data.data.message}`]);
        } else if (data.type === 'status') {
          setLogs(prev => [...prev, `\n[STATUS] ${data.data.message}`]);
        } else if (data.type === 'decision') {
          setLogs(prev => [...prev, `[${data.data.node.toUpperCase()}] ${data.data.decision}`]);
          if (data.data.reasoning) {
            setLogs(prev => [...prev, `  → ${data.data.reasoning}`]);
          }
        } else if (data.type === 'progress') {
          setLogs(prev => [...prev, `[PROGRESS] ${data.data.node}: ${data.data.percent}%`]);
        } else if (data.type === 'error') {
          setLogs(prev => [...prev, `[ERROR] [${data.data.node}] ${data.data.message}`]);
        } else if (data.type === 'qa_issue') {
          setLogs(prev => [...prev, `[QA ISSUE] ${data.data.description}`]);
          if (data.data.suggestion) {
            setLogs(prev => [...prev, `  → Fix: ${data.data.suggestion}`]);
          }
        } else if (data.type === 'qa_metrics') {
          setLogs(prev => [...prev, `\n[QA METRICS] Score: ${data.data.score}/100`]);
          if (data.data.metrics) {
            setLogs(prev => [...prev, `  - Structural: ${data.data.metrics.structuralSimilarity || 'N/A'}`]);
            setLogs(prev => [...prev, `  - Visual: ${data.data.metrics.visualSimilarity || 'N/A'}`]);
            setLogs(prev => [...prev, `  - Layout: ${data.data.metrics.layoutAccuracy || 'N/A'}`]);
            setLogs(prev => [...prev, `  - Color: ${data.data.metrics.colorAccuracy || 'N/A'}`]);
          }
        } else if (data.type === 'complete') {
          setLogs(prev => [...prev, `\n[COMPLETE] QA Score: ${data.data.qaScore}/100`]);
          eventSource.close();
        }
      };
      
      eventSource.onerror = (error) => {
        console.error('SSE Error:', error);
        setLogs(prev => [...prev, '[ERROR] Stream connection error']);
      };
      
      // Update result when clone completes
      setResult(cloneData);
      
    } catch (error: any) {
      console.error('Error:', error);
      setLogs(prev => [...prev, `Error: ${error.message}`]);
    } finally {
      setLoading(false);
    }
  };
  
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="container mx-auto p-8">
        <h1 className="text-4xl font-bold mb-8">Website Cloning Agent</h1>
        
        <div className="mb-8">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com"
            className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-lg text-white"
            disabled={loading}
          />
          <button
            onClick={handleClone}
            disabled={loading || !url}
            className="mt-4 px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 rounded-lg"
          >
            {loading ? 'Cloning...' : 'Clone Website'}
          </button>
        </div>
        
        <div className="grid grid-cols-2 gap-8">
          {/* Logs */}
          <div>
            <h2 className="text-xl font-semibold mb-4">Agent Logs</h2>
            <div className="bg-gray-900 rounded-lg p-4 h-[600px] overflow-y-auto font-mono text-sm">
              {logs.length === 0 && <p className="text-gray-500">Waiting for logs...</p>}
              {logs.map((log, i) => {
                // Color code different log types
                let className = "mb-1 text-green-400";
                if (log.includes('[ERROR]')) {
                  className = "mb-1 text-red-400";
                } else if (log.includes('[STATUS]')) {
                  className = "mb-1 text-blue-400 font-semibold";
                } else if (log.includes('[PROGRESS]')) {
                  className = "mb-1 text-yellow-400";
                } else if (log.includes('[QA ISSUE]')) {
                  className = "mb-1 text-orange-400 font-semibold";
                } else if (log.includes('[QA METRICS]')) {
                  className = "mb-1 text-purple-400 font-semibold";
                } else if (log.includes('[SCOUT]') || log.includes('[ARCHITECT]') || log.includes('[CODER]') || log.includes('[QA]')) {
                  className = "mb-1 text-cyan-400";
                } else if (log.startsWith('  →') || log.startsWith('  -')) {
                  className = "mb-1 text-gray-400 ml-4";
                }
                return <div key={i} className={className}>{log}</div>;
              })}
            </div>
          </div>
          
          {/* Preview */}
          <div>
            <h2 className="text-xl font-semibold mb-4">Preview</h2>
            {result?.code ? (
              <Sandpack
                template="react-ts"
                files={(() => {
                  // Normalize file paths - remove 'src/' prefix and ensure leading slash
                  const normalizedFiles: Record<string, string> = {};
                  
                  for (const [key, value] of Object.entries(result.code.files)) {
                    // Remove 'src/' prefix if present
                    let normalizedKey = key.replace(/^src\//, '');
                    // Ensure leading slash for Sandpack
                    if (!normalizedKey.startsWith('/')) {
                      normalizedKey = '/' + normalizedKey;
                    }
                    normalizedFiles[normalizedKey] = value as string;
                  }
                  
                  // Ensure App.tsx exists (check various formats)
                  if (!normalizedFiles['/App.tsx']) {
                    const appFile = normalizedFiles['/src/App.tsx'] || 
                                   Object.keys(normalizedFiles).find(k => k.toLowerCase().endsWith('app.tsx'));
                    if (appFile) {
                      normalizedFiles['/App.tsx'] = normalizedFiles[appFile];
                    }
                  }
                  
                  return normalizedFiles;
                })()}
                options={{
                  showNavigator: false,
                  editorHeight: 600
                }}
                theme="dark"
              />
            ) : (
              <div className="bg-gray-900 rounded-lg h-[600px] flex items-center justify-center text-gray-500">
                Preview will appear here
              </div>
            )}
          </div>
        </div>
        
        {result && (
          <div className="mt-8 bg-gray-900 rounded-lg p-6">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-gray-400">Status</p>
                <p className="text-lg font-semibold">{result.status}</p>
              </div>
              <div>
                <p className="text-gray-400">QA Score</p>
                <p className="text-lg font-semibold">{result.qaScore}/100</p>
              </div>
              <div>
                <p className="text-gray-400">Files</p>
                <p className="text-lg font-semibold">{Object.keys(result.code?.files || {}).length}</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
