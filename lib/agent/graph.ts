import { StateGraph, END } from '@langchain/langgraph';
import { AgentState } from '@/lib/types';
import { scoutNode } from './nodes/scoutNode';
import { architectNode } from './nodes/architectNode';
import { coderNode } from './nodes/coderNode';
import { qaNode } from './nodes/qaNode';
import { redis } from '@/lib/redis';

const workflow = new StateGraph<AgentState>({
  channels: {
    jobId: null,
    url: null,
    userInstructions: null,
    status: null,
    currentNode: null,
    scoutData: null,
    architectPlan: null,
    generatedCode: null,
    qaResult: null,
    retryCount: null,
    maxRetries: null,
    attemptHistory: null,
    decisionLog: null,
    errors: null,
    startedAt: null,
    completedAt: null
  }
});

workflow.addNode('scout', scoutNode);
workflow.addNode('architect', architectNode);
workflow.addNode('coder', coderNode);
workflow.addNode('qa', qaNode);

function routeAfterQA(state: AgentState): string {
  if (state.status === 'complete' || state.status === 'failed') {
    return END;
  }
  
  if (state.currentNode === 'qa' && state.status === 'coding') {
    return 'coder'; // Retry
  }
  
  return END;
}

workflow.addEdge('scout', 'architect');
workflow.addEdge('architect', 'coder');
workflow.addEdge('coder', 'qa');
workflow.addConditionalEdges('qa', routeAfterQA, {
  'coder': 'coder',
  [END]: END
});

workflow.setEntryPoint('scout');

export const agentGraph = workflow.compile();

// Helper to update Redis with state
async function updateRedisState(state: AgentState) {
  try {
    await redis.setex(
      `clone:${state.jobId}`,
      86400,
      JSON.stringify(state)
    );
  } catch (error) {
    console.error('[Agent] Failed to update Redis:', error);
  }
}

export async function runAgent(url: string, userInstructions?: string, jobId?: string): Promise<AgentState> {
  const finalJobId = jobId || `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  
  const initialState: AgentState = {
    jobId: finalJobId,
    url,
    userInstructions,
    status: 'pending',
    currentNode: null,
    retryCount: 0,
    maxRetries: 3,
    attemptHistory: [],
    decisionLog: [],
    errors: [],
    startedAt: new Date().toISOString()
  };
  
  // Store initial state
  await updateRedisState(initialState);
  
  console.log(`[Agent] Starting job ${finalJobId}`);
  
  // Execute graph nodes manually to capture intermediate states
  let currentState = initialState;
  
  try {
    // Scout node
    currentState = { ...currentState, status: 'scouting', currentNode: 'scout' };
    await updateRedisState(currentState);
    const scoutResult = await scoutNode(currentState);
    currentState = { ...currentState, ...scoutResult };
    await updateRedisState(currentState);
    
    // Architect node
    currentState = { ...currentState, status: 'planning', currentNode: 'architect' };
    await updateRedisState(currentState);
    const architectResult = await architectNode(currentState);
    currentState = { ...currentState, ...architectResult };
    await updateRedisState(currentState);
    
    // Coder node
    currentState = { ...currentState, status: 'coding', currentNode: 'coder' };
    await updateRedisState(currentState);
    const coderResult = await coderNode(currentState);
    currentState = { ...currentState, ...coderResult };
    await updateRedisState(currentState);
    
    // QA node
    currentState = { ...currentState, status: 'qa', currentNode: 'qa' };
    await updateRedisState(currentState);
    const qaResult = await qaNode(currentState);
    currentState = { ...currentState, ...qaResult };
    await updateRedisState(currentState);
    
    // Handle retry loop if QA score is low
    let retryCount = 0;
    while (
      currentState.status === 'coding' && 
      currentState.retryCount < currentState.maxRetries &&
      retryCount < currentState.maxRetries
    ) {
      retryCount++;
      currentState = { ...currentState, retryCount, status: 'coding', currentNode: 'coder' };
      await updateRedisState(currentState);
      
      const retryCoderResult = await coderNode(currentState);
      currentState = { ...currentState, ...retryCoderResult };
      await updateRedisState(currentState);
      
      if (currentState.status === 'qa') {
        currentState = { ...currentState, status: 'qa', currentNode: 'qa' };
        await updateRedisState(currentState);
        const retryQaResult = await qaNode(currentState);
        currentState = { ...currentState, ...retryQaResult };
        await updateRedisState(currentState);
      }
    }
    
    // Mark as complete if not already failed
    if (currentState.status !== 'failed') {
      currentState = { ...currentState, status: 'complete', completedAt: new Date().toISOString() };
    }
    
  } catch (error: any) {
    console.error(`[Agent] Error in job ${finalJobId}:`, error);
    currentState = {
      ...currentState,
      status: 'failed',
      errors: [
        ...(currentState.errors || []),
        {
          node: currentState.currentNode || 'unknown',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      ],
      completedAt: new Date().toISOString()
    };
    await updateRedisState(currentState);
  }
  
  console.log(`[Agent] Job ${finalJobId} completed: ${currentState.status}`);
  
  // Final update
  await updateRedisState(currentState);
  
  return currentState;
}
