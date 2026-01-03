import { ChatAnthropic } from '@langchain/anthropic';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { OpenAI } from 'openai';
import { ScoutOutput, ArchitectPlan } from '@/lib/types';
import { MODEL_CONFIG } from '@/lib/config';

// Fallback models for Gemini (in order of preference)
const GEMINI_FALLBACK_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-pro-latest', 'gemini-2.0-flash-001'];

async function callLLMWithFallback(prompt: string, modelType: 'claude' | 'gemini' | 'openai') {
  if (modelType === 'claude') {
    const llm = new ChatAnthropic({
      modelName: 'claude-3-5-sonnet-20241022',
      temperature: 0.3,
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    const response = await llm.invoke(prompt);
    return response.content.toString();
  }
  
  if (modelType === 'openai') {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 4000
    });
    return response.choices[0].message.content || '';
  }
  
  // Gemini
  
  const geminiAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '');
  
  // Try models in order until one works
  for (const modelName of GEMINI_FALLBACK_MODELS) {
    try {
      const model = geminiAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      console.log(`[Architect] Using model: ${modelName}`);
      return result.response.text();
    } catch (error: any) {
      const errorMsg = error.message || error.toString();
      // Check if it's a quota error
      if (errorMsg.includes('429') || errorMsg.includes('quota')) {
        console.warn(`[Architect] Quota exceeded for ${modelName}, trying fallback...`);
        continue;
      }
      // Check if it's a token limit error (400 with token-related message)
      if (errorMsg.includes('400') && (errorMsg.includes('token') || errorMsg.includes('exceeds') || errorMsg.includes('1048576'))) {
        console.warn(`[Architect] Token limit exceeded for ${modelName}, trying fallback...`);
        continue;
      }
      // For other errors, throw immediately
      throw error;
    }
  }
  throw new Error('All Gemini models exceeded quota/token limits or unavailable');
}

// Helper function to chunk scout data for pagination
function chunkScoutData(scoutData: ScoutOutput, chunkSize: number = 200) {
  const chunks: Array<{ type: string; data: any; index: number; total: number }> = [];
  
  // Chunk computed styles
  const styleChunks = Math.ceil(scoutData.computedStyles.length / chunkSize);
  for (let i = 0; i < styleChunks; i++) {
    chunks.push({
      type: 'styles',
      data: scoutData.computedStyles.slice(i * chunkSize, (i + 1) * chunkSize),
      index: i,
      total: styleChunks
    });
  }
  
  // Chunk layout data
  const layoutChunks = Math.ceil(scoutData.layout.length / chunkSize);
  for (let i = 0; i < layoutChunks; i++) {
    chunks.push({
      type: 'layout',
      data: scoutData.layout.slice(i * chunkSize, (i + 1) * chunkSize),
      index: i,
      total: layoutChunks
    });
  }
  
  // Chunk animations
  const animChunks = Math.ceil(scoutData.animations.length / chunkSize);
  for (let i = 0; i < animChunks; i++) {
    chunks.push({
      type: 'animations',
      data: scoutData.animations.slice(i * chunkSize, (i + 1) * chunkSize),
      index: i,
      total: animChunks
    });
  }
  
  return chunks;
}

// Helper to get initial overview (always sent first)
function getScoutOverview(scoutData: ScoutOutput) {
  return {
    url: scoutData.url,
    meta: scoutData.meta,
    dom: {
      ...scoutData.dom,
      // Keep full DOM structure but limit depth for overview
      children: scoutData.dom.children.slice(0, 10).map((child: any) => ({
        ...child,
        children: child.children?.slice(0, 3) || []
      }))
    },
    assets: scoutData.assets,
    stats: {
      totalStyles: scoutData.computedStyles.length,
      totalLayout: scoutData.layout.length,
      totalAnimations: scoutData.animations.length,
      domNodes: countDOMNodes(scoutData.dom)
    }
  };
}

function countDOMNodes(node: any): number {
  return 1 + (node.children?.reduce((sum: number, child: any) => sum + countDOMNodes(child), 0) || 0);
}

export async function architectNode(state: any): Promise<Partial<any>> {
  const { scoutData, userInstructions } = state;
  
  console.log(`[Architect] Creating structural plan using ${MODEL_CONFIG.architectModel}...`);
  
  try {
    const modelType = MODEL_CONFIG.architectModel;
    
    // Get overview first
    const overview = getScoutOverview(scoutData);
    console.log(`[Architect] Processing ${scoutData.computedStyles.length} styles, ${scoutData.layout.length} layout items in chunks using ${modelType}...`);
    
    // Initial prompt with overview
    const initialPrompt = `You are an expert UI/UX architect. I'll send you website data in chunks. Start by analyzing the overview and prepare to receive detailed data.

OVERVIEW:
${JSON.stringify(overview, null, 2)}

USER INSTRUCTIONS:
${userInstructions || 'Clone the website accurately'}

I'll now send you detailed data in chunks. After each chunk, acknowledge receipt and note any important patterns you see.`;
    
    let accumulatedContext = await callLLMWithFallback(initialPrompt, modelType);
    console.log(`[Architect] Overview processed, received initial context`);
    
    // Process data in chunks (larger chunks = fewer API calls, but stay under token limits)
    const chunks = chunkScoutData(scoutData, 300); // 300 items per chunk
    let planSummary = '';
    const maxChunksToProcess = 20; // Limit total chunks to prevent too many API calls
    
    const chunksToProcess = chunks.slice(0, maxChunksToProcess);
    console.log(`[Architect] Processing ${chunksToProcess.length} chunks (out of ${chunks.length} total)`);
    
    for (let i = 0; i < chunksToProcess.length; i++) {
      const chunk = chunksToProcess[i];
      console.log(`[Architect] Processing chunk ${i + 1}/${chunksToProcess.length}: ${chunk.type} (${chunk.index + 1}/${chunk.total})`);
      
      const chunkPrompt = `Here is chunk ${i + 1} of ${chunksToProcess.length}:

CHUNK TYPE: ${chunk.type}
CHUNK ${chunk.index + 1} of ${chunk.total} for this type:
${JSON.stringify(chunk.data, null, 2)}

${i > 0 ? `PREVIOUS ANALYSIS SUMMARY:\n${planSummary || accumulatedContext.slice(0, 300)}` : ''}

Analyze this chunk and note:
1. Key component patterns
2. Important style rules
3. Layout structures
Keep response under 200 words.`;
      
      try {
        const chunkResponse = await callLLMWithFallback(chunkPrompt, modelType);
        
        if (i === 0) {
          accumulatedContext = chunkResponse;
        } else {
          accumulatedContext += '\n\n' + chunkResponse;
        }
      } catch (error: any) {
        // If chunk fails due to token limits, reduce chunk size and retry
        if (error.message?.includes('token') || error.message?.includes('exceeds')) {
          console.warn(`[Architect] Chunk ${i + 1} too large, reducing size...`);
          // Split chunk in half and process separately
          const halfSize = Math.floor(chunk.data.length / 2);
          const chunk1 = { ...chunk, data: chunk.data.slice(0, halfSize) };
          const chunk2 = { ...chunk, data: chunk.data.slice(halfSize), index: chunk.index + 0.5 };
          
          try {
            const prompt1 = `Here is a partial chunk (part 1 of 2) of type ${chunk.type}:\n${JSON.stringify(chunk1.data, null, 2)}\n\nAnalyze briefly (max 150 words).`;
            const response1 = await callLLMWithFallback(prompt1, modelType);
            
            const prompt2 = `Here is a partial chunk (part 2 of 2) of type ${chunk.type}:\n${JSON.stringify(chunk2.data, null, 2)}\n\nPrevious analysis: ${response1}\n\nAnalyze briefly (max 150 words).`;
            const response2 = await callLLMWithFallback(prompt2, modelType);
            
            accumulatedContext += '\n\n' + response1 + '\n' + response2;
          } catch (retryError) {
            console.warn(`[Architect] Skipping chunk ${i + 1} due to size constraints`);
            // Skip this chunk and continue
          }
        } else {
          throw error; // Re-throw non-token errors
        }
      }
      
      // Summarize every 3 chunks to prevent context bloat
      if ((i + 1) % 3 === 0 || i === chunksToProcess.length - 1) {
        const summaryPrompt = `Summarize all analysis so far (${i + 1} chunks processed). Focus on:
1. Component structure and hierarchy
2. Key CSS patterns and style rules
3. Layout patterns
4. Any notable design patterns

Keep summary under 300 words.`;
        planSummary = await callLLMWithFallback(summaryPrompt, modelType);
        accumulatedContext = planSummary;
      }
    }
    
    if (chunks.length > maxChunksToProcess) {
      console.log(`[Architect] Note: Processed ${maxChunksToProcess} of ${chunks.length} chunks. Remaining data will be summarized.`);
    }
    
    // Final plan generation with full context
    const finalPrompt = `Based on all the data chunks I've sent, create a comprehensive component plan.

CONTEXT SUMMARY:
${planSummary || accumulatedContext.slice(0, 1000)}

FULL SCOUT DATA STATS:
- Styles: ${scoutData.computedStyles.length} entries
- Layout: ${scoutData.layout.length} entries  
- Animations: ${scoutData.animations.length} entries
- Assets: ${scoutData.assets.length} images

Generate the complete component plan now:

USER INSTRUCTIONS:
${userInstructions || 'None - clone exactly as-is'}

HIERARCHY OF TRUTH:
1. Live DOM data (highest priority)
2. Computed styles (second priority)
3. User instructions (lowest priority)

If user instructions conflict with live data:
- Default to LIVE DATA
- Note the deviation in deviationNotes
- Explain your reasoning

OUTPUT FORMAT (JSON ONLY, NO MARKDOWN):
{
  "components": [
    {
      "name": "Header",
      "type": "layout",
      "selector": "#header",
      "props": {},
      "tailwindClasses": ["bg-white", "shadow-md", "p-4"],
      "children": []
    }
  ],
  "conflicts": [],
  "deviationNotes": [],
  "colorPalette": {
    "primary": "#3b82f6",
    "secondary": "#8b5cf6",
    "background": "#ffffff",
    "text": "#1f2937",
    "accent": "#10b981"
  },
  "typography": {
    "headingFont": "Inter",
    "bodyFont": "Inter",
    "sizes": {
      "h1": "text-4xl",
      "h2": "text-3xl",
      "body": "text-base"
    }
  },
  "spacing": {
    "unit": 4,
    "scale": [0, 1, 2, 4, 6, 8, 12, 16, 24, 32]
  }
}

Extract 3-7 main components. Map CSS values to Tailwind classes. Be specific about colors.`;

    const content = await callLLMWithFallback(finalPrompt, modelType);
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Architect failed to return valid JSON');
    }
    
    const plan: ArchitectPlan = JSON.parse(jsonMatch[0]);
    
    console.log('[Architect] Plan created!');
    console.log(`  - Components: ${plan.components.length}`);
    
    return {
      architectPlan: plan,
      status: 'coding',
      currentNode: 'coder',
      decisionLog: [
        ...state.decisionLog,
        {
          timestamp: new Date().toISOString(),
          node: 'architect',
          decision: 'Created component plan',
          reasoning: `Designed ${plan.components.length} components`
        }
      ]
    };
    
  } catch (error: any) {
    console.error('[Architect] Error:', error.message);
    
    return {
      status: 'failed',
      errors: [
        ...state.errors,
        {
          node: 'architect',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      ]
    };
  }
}
