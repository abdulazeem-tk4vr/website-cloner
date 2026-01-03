import { ChatAnthropic } from '@langchain/anthropic';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { OpenAI } from 'openai';
import { ArchitectPlan, GeneratedCode, ScoutOutput } from '@/lib/types';
import { MODEL_CONFIG } from '@/lib/config';

// Fallback models for Gemini (in order of preference)
const GEMINI_FALLBACK_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-pro-latest', 'gemini-2.0-flash-001'];

async function callCoderLLMWithFallback(systemPrompt: string, userPrompt: string, modelType: 'claude' | 'gemini' | 'openai') {
  if (modelType === 'claude') {
    const llm = new ChatAnthropic({
      modelName: 'claude-3-5-sonnet-20241022',
      temperature: 0.2,
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    const response = await llm.invoke([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]);
    return response.content.toString();
  }
  
  if (modelType === 'openai') {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 4000
    });
    return response.choices[0].message.content || '';
  }
  
  // Gemini
  
  const geminiAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '');
  const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;
  
  // Try models in order until one works
  for (const modelName of GEMINI_FALLBACK_MODELS) {
    try {
      const model = geminiAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(combinedPrompt);
      console.log(`[Coder] Using model: ${modelName}`);
      return result.response.text();
    } catch (error: any) {
      const errorMsg = error.message || error.toString();
      // Check if it's a quota error
      if (errorMsg.includes('429') || errorMsg.includes('quota')) {
        console.warn(`[Coder] Quota exceeded for ${modelName}, trying fallback...`);
        continue;
      }
      // Check if it's a token limit error (400 with token-related message)
      if (errorMsg.includes('400') && (errorMsg.includes('token') || errorMsg.includes('exceeds') || errorMsg.includes('1048576'))) {
        console.warn(`[Coder] Token limit exceeded for ${modelName}, trying fallback...`);
        continue;
      }
      // For other errors, throw immediately
      throw error;
    }
  }
  throw new Error('All Gemini models exceeded quota/token limits or unavailable');
}

export async function coderNode(state: any): Promise<Partial<any>> {
  const { architectPlan, scoutData, qaResult, retryCount } = state;
  
  console.log(`[Coder] Generating React code using ${MODEL_CONFIG.coderModel}...`);
  
  const qaFeedback = qaResult?.issues?.map(i => `- ${i.description}: ${i.suggestion}`).join('\n') || '';
  const isRetry = retryCount > 0;
  
  try {
    // CRITICAL: Extract asset mapping for the prompt
    const assetMappings = (scoutData as ScoutOutput).assets.map(a => 
      `${a.originalUrl} → ${a.localPath}`
    ).join('\n');
    
    const systemPrompt = `You are an expert React + TypeScript + Tailwind CSS developer.

CRITICAL RULES:
1. Use ONLY Tailwind CSS classes (no custom CSS)
2. Do NOT invent colors or styles - use ONLY what's in the plan
3. Create separate component files
4. Use Framer Motion for animations
5. Return ONLY valid JSON (no markdown, no code blocks)

ASSET HANDLING (CRITICAL):
The Scout has downloaded images to local paths. Here are the mappings:
${assetMappings}

When generating <img> tags, if the src matches an originalUrl above, use the corresponding localPath instead.
Example: <img src="/temp/assets/job-123/img-001.png" />

${isRetry ? `PREVIOUS ISSUES TO FIX:\n${qaFeedback}` : ''}`;

    // Truncate asset list if too long
    const assetsToSend = scoutData.assets.slice(0, 20);
    
    const userPrompt = `Convert this plan into React code:

PLAN:
${JSON.stringify(architectPlan, null, 2)}

ASSETS AVAILABLE (${scoutData.assets.length} total, showing first ${assetsToSend.length}):
${JSON.stringify(assetsToSend, null, 2)}

OUTPUT FORMAT (JSON ONLY):
{
  "files": {
    "App.tsx": "import React from 'react';\\n\\nexport default function App() {\\n  return <div>...</div>;\\n}",
    "components/Header.tsx": "..."
  },
  "dependencies": [
    { "component": "App", "imports": ["./components/Header"] }
  ],
  "packages": {
    "dependencies": {
      "framer-motion": "^10.16.0"
    },
    "devDependencies": {}
  }
}

CRITICAL: You MUST include "App.tsx" in the files object. This is the main entry point and is required.
Generate clean, production-ready React code now:`;

    const modelType = MODEL_CONFIG.coderModel;
    console.log(`[Coder] Using model: ${modelType}`);
    const content = await callCoderLLMWithFallback(systemPrompt, userPrompt, modelType);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('Coder failed to return valid JSON');
    }
    
    const generatedCode: GeneratedCode = JSON.parse(jsonMatch[0]);
    
    // Check for App.tsx in various possible formats
    const appFile = generatedCode.files['App.tsx'] || 
                    generatedCode.files['/App.tsx'] ||
                    generatedCode.files['app.tsx'] ||
                    generatedCode.files['/app.tsx'] ||
                    Object.keys(generatedCode.files).find(key => key.toLowerCase().includes('app.tsx'));
    
    if (!appFile) {
      // Try to find any main component file
      const mainFile = Object.keys(generatedCode.files).find(key => 
        key.toLowerCase().includes('app') || 
        key.toLowerCase().includes('main') ||
        key.toLowerCase().endsWith('.tsx')
      );
      
      if (mainFile) {
        // Rename to App.tsx
        generatedCode.files['App.tsx'] = generatedCode.files[mainFile];
        console.log(`[Coder] Renamed ${mainFile} to App.tsx`);
      } else {
        throw new Error(`Generated code missing App.tsx. Available files: ${Object.keys(generatedCode.files).join(', ')}`);
      }
    } else if (appFile !== generatedCode.files['App.tsx']) {
      // Normalize to App.tsx
      generatedCode.files['App.tsx'] = appFile;
    }
    
    console.log('[Coder] Code generated!');
    console.log(`  - Files: ${Object.keys(generatedCode.files).length}`);
    
    return {
      generatedCode,
      status: 'qa',
      currentNode: 'qa',
      decisionLog: [
        ...state.decisionLog,
        {
          timestamp: new Date().toISOString(),
          node: 'coder',
          decision: isRetry ? 'Regenerated code with fixes' : 'Generated initial code',
          reasoning: `Created ${Object.keys(generatedCode.files).length} files`
        }
      ]
    };
    
  } catch (error: any) {
    console.error('[Coder] Error:', error.message);
    
    return {
      status: 'failed',
      errors: [
        ...state.errors,
        {
          node: 'coder',
          error: error.message,
          timestamp: new Date().toISOString()
        }
      ]
    };
  }
}
