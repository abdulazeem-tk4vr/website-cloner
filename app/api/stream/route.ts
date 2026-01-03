import { NextRequest } from 'next/server';
import { redis } from '@/lib/redis';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get('jobId');
  
  if (!jobId) {
    return new Response('Job ID required', { status: 400 });
  }
  
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    async start(controller) {
      let lastDecisionCount = 0;
      let lastErrorCount = 0;
      let lastStatus = '';
      let lastProgress: number | null = null;
      let qaIssuesSent = false;
      let qaMetricsSent = false;
      const maxPollTime = 600000; // 10 minutes max (for pagination)
      const startTime = Date.now();
      
      // Send initial status
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
        type: 'status', 
        data: { status: 'pending', message: 'Starting...' } 
      })}\n\n`));
      
      const pollInterval = setInterval(async () => {
        try {
          // Check if timeout exceeded
          if (Date.now() - startTime > maxPollTime) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
              type: 'error', 
              data: { message: 'Stream timeout', node: 'stream' } 
            })}\n\n`));
            clearInterval(pollInterval);
            controller.close();
            return;
          }
          
          // Get job state from Redis
          const jobData = await redis.get(`clone:${jobId}`);
          
          if (!jobData) {
            // Job not found yet, wait
            return;
          }
          
          const state = JSON.parse(jobData);
          
          // Send status updates
          if (state.status !== lastStatus) {
            const statusMessages: Record<string, string> = {
              'scouting': 'Analyzing website...',
              'planning': 'Creating component plan...',
              'coding': 'Generating React code...',
              'qa': 'Validating with vision AI...',
              'complete': 'Completed!',
              'failed': 'Failed'
            };
            
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
              type: 'status', 
              data: { status: state.status, message: statusMessages[state.status] || state.status } 
            })}\n\n`));
            lastStatus = state.status;
          }
          
          // Send new decision logs
          if (state.decisionLog && state.decisionLog.length > lastDecisionCount) {
            const newDecisions = state.decisionLog.slice(lastDecisionCount);
            for (const decision of newDecisions) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
                type: 'decision', 
                data: { 
                  node: decision.node, 
                  decision: decision.decision, 
                  reasoning: decision.reasoning 
                } 
              })}\n\n`));
            }
            lastDecisionCount = state.decisionLog.length;
          }
          
          // Send new errors
          if (state.errors && state.errors.length > lastErrorCount) {
            const newErrors = state.errors.slice(lastErrorCount);
            for (const error of newErrors) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
                type: 'error', 
                data: { 
                  message: error.error, 
                  node: error.node,
                  timestamp: error.timestamp
                } 
              })}\n\n`));
            }
            lastErrorCount = state.errors.length;
          }
          
          // Send QA issues if available (only once)
          if (state.qaResult && state.qaResult.issues && state.qaResult.issues.length > 0 && !qaIssuesSent) {
            if (state.status === 'qa' || state.status === 'complete' || state.status === 'coding') {
              for (const issue of state.qaResult.issues) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
                  type: 'qa_issue', 
                  data: { 
                    description: issue.description,
                    suggestion: issue.suggestion,
                    severity: issue.severity || 'medium'
                  } 
                })}\n\n`));
              }
              qaIssuesSent = true;
            }
          }
          
          // Send QA metrics if available (only once per QA result)
          if (state.qaResult && state.qaResult.metrics && !qaMetricsSent) {
            if (state.status === 'qa' || state.status === 'complete' || state.status === 'coding') {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
                type: 'qa_metrics', 
                data: { 
                  score: state.qaResult.score,
                  metrics: state.qaResult.metrics,
                  passed: state.qaResult.passed
                } 
              })}\n\n`));
              qaMetricsSent = true;
            }
          }
          
          // Reset flags when QA result changes (new QA run)
          if (state.currentNode === 'qa' && state.status === 'qa' && !state.qaResult) {
            qaIssuesSent = false;
            qaMetricsSent = false;
          }
          
          // Send progress updates based on currentNode (only when it changes)
          if (state.currentNode) {
            const progressMap: Record<string, number> = {
              'scout': 25,
              'architect': 50,
              'coder': 75,
              'qa': 90
            };
            
            const currentProgress = progressMap[state.currentNode] || 0;
            
            // Only send if progress changed (track last progress)
            if (!lastProgress || lastProgress !== currentProgress) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
                type: 'progress', 
                data: { 
                  node: state.currentNode, 
                  percent: currentProgress 
                } 
              })}\n\n`));
              lastProgress = currentProgress;
            }
          }
          
          // Send completion
          if (state.status === 'complete' || state.status === 'failed') {
            if (state.status === 'complete' && state.generatedCode) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
                type: 'complete', 
                data: { 
                  code: state.generatedCode, 
                  qaScore: state.qaResult?.score || 0 
                } 
              })}\n\n`));
            }
            clearInterval(pollInterval);
            controller.close();
          }
        } catch (error: any) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
            type: 'error', 
            data: { message: error.message, node: 'stream' } 
          })}\n\n`));
        }
      }, 2000); // Poll every 2 seconds (reduced frequency to prevent spam)
      
      // Cleanup on client disconnect
      request.signal.addEventListener('abort', () => {
        clearInterval(pollInterval);
        controller.close();
      });
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}
