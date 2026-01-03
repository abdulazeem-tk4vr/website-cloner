import { NextRequest, NextResponse } from 'next/server';
import { runAgent } from '@/lib/agent/graph';
import { redis } from '@/lib/redis';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url, userInstructions } = body;
    
    if (!url) {
      return NextResponse.json({ error: 'URL required' }, { status: 400 });
    }
    
    // Validate URL
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }
    
    console.log(`[API] Cloning: ${url}`);
    
    // Generate jobId and return immediately for streaming
    const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    
    // Store initial state in Redis for streaming
    await redis.setex(
      `clone:${jobId}`,
      86400,
      JSON.stringify({
        jobId,
        url,
        userInstructions,
        status: 'pending',
        currentNode: null,
        decisionLog: [],
        errors: [],
        startedAt: new Date().toISOString()
      })
    );
    
    // Return jobId immediately, run agent in background
    runAgent(url, userInstructions, jobId).catch(error => {
      console.error('[API] Agent error:', error);
      // Update Redis with error
      redis.setex(
        `clone:${jobId}`,
        86400,
        JSON.stringify({
          jobId,
          url,
          status: 'failed',
          errors: [{ node: 'agent', error: error.message, timestamp: new Date().toISOString() }],
          decisionLog: [],
          startedAt: new Date().toISOString()
        })
      );
    });
    
    return NextResponse.json({
      success: true,
      jobId,
      status: 'pending',
      message: 'Cloning started. Use /api/stream?jobId=' + jobId + ' for live updates.'
    });
    
  } catch (error: any) {
    console.error('[API] Error:', error);
    return NextResponse.json(
      { error: 'Internal error', message: error.message },
      { status: 500 }
    );
  }
}
