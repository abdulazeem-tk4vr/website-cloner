// ============================================================================
// SCOUT TYPES
// ============================================================================

export interface DOMSnapshot {
  html: string;
  selector: string;
  tag: string;
  classes: string[];
  textContent: string;
  children: DOMSnapshot[];
}

export interface ComputedStyleData {
  selector: string;
  styles: {
    display: string;
    position: string;
    width: string;
    height: string;
    padding: string;
    margin: string;
    color: string;
    backgroundColor: string;
    fontFamily: string;
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    flexDirection?: string;
    justifyContent?: string;
    alignItems?: string;
    gridTemplateColumns?: string;
    gap?: string;
    transition?: string;
    animation?: string;
    transform?: string;
  };
}

export interface LayoutData {
  selector: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  zIndex: number;
}

export interface AssetData {
  type: 'image' | 'font' | 'video';
  originalUrl: string;
  localPath: string; // CRITICAL: Must be web-accessible path like /temp/assets/job-123/img-001.png
  dimensions?: { width: number; height: number };
  format?: string;
}

export interface AnimationData {
  selector: string;
  type: 'css' | 'scroll-trigger';
  properties: {
    property: string;
    from: string;
    to: string;
    duration: string;
    easing: string;
    delay?: string;
  }[];
}

export interface ScoutOutput {
  url: string;
  timestamp: string;
  dom: DOMSnapshot;
  computedStyles: ComputedStyleData[];
  layout: LayoutData[];
  assets: AssetData[];
  animations: AnimationData[];
  breakpoints: {
    mobile: number;
    tablet: number;
    desktop: number;
  };
  meta: {
    title: string;
    description: string;
    viewport: string;
    theme: 'light' | 'dark' | 'unknown';
  };
}

// ============================================================================
// ARCHITECT TYPES
// ============================================================================

export interface ComponentSpec {
  name: string;
  type: 'layout' | 'content' | 'interactive';
  selector: string;
  props: Record<string, any>;
  children?: ComponentSpec[];
  tailwindClasses: string[];
}

export interface ConflictResolution {
  type: 'user-vs-reality' | 'ambiguous-structure' | 'missing-data';
  description: string;
  decision: string;
  reasoning: string;
}

export interface ArchitectPlan {
  components: ComponentSpec[];
  conflicts: ConflictResolution[];
  deviationNotes: string[];
  colorPalette: {
    primary: string;
    secondary: string;
    background: string;
    text: string;
    accent: string;
  };
  typography: {
    headingFont: string;
    bodyFont: string;
    sizes: Record<string, string>;
  };
  spacing: {
    unit: number;
    scale: number[];
  };
}

// ============================================================================
// CODER TYPES
// ============================================================================

export interface GeneratedCode {
  files: {
    [filepath: string]: string;
  };
  dependencies: {
    component: string;
    imports: string[];
  }[];
  packages: {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
}

// ============================================================================
// QA TYPES
// ============================================================================

export interface QAResult {
  score: number;
  passed: boolean;
  metrics: {
    structuralSimilarity: number;
    visualSimilarity: number;
    layoutAccuracy: number;
    colorAccuracy: number;
  };
  screenshots: {
    original: string;
    generated: string;
    diff?: string;
  };
  issues: {
    severity: 'critical' | 'major' | 'minor';
    category: 'layout' | 'color' | 'typography' | 'spacing' | 'component';
    description: string;
    suggestion: string;
  }[];
}

// ============================================================================
// AGENT STATE
// ============================================================================

export interface AgentState {
  jobId: string;
  url: string;
  userInstructions?: string;
  status: 'pending' | 'scouting' | 'planning' | 'coding' | 'qa' | 'complete' | 'failed';
  currentNode: 'scout' | 'architect' | 'coder' | 'qa' | null;
  scoutData?: ScoutOutput;
  architectPlan?: ArchitectPlan;
  generatedCode?: GeneratedCode;
  qaResult?: QAResult;
  retryCount: number;
  maxRetries: number;
  attemptHistory: {
    attempt: number;
    qaScore: number;
    issues: string[];
    timestamp: string;
  }[];
  decisionLog: {
    timestamp: string;
    node: string;
    decision: string;
    reasoning: string;
  }[];
  errors: {
    node: string;
    error: string;
    timestamp: string;
  }[];
  startedAt: string;
  completedAt?: string;
  totalCost?: number;
}

export type SSEEvent = 
  | { type: 'status'; data: { status: AgentState['status']; message: string } }
  | { type: 'log'; data: { level: 'info' | 'warn' | 'error'; message: string; timestamp: string } }
  | { type: 'decision'; data: { node: string; decision: string; reasoning: string } }
  | { type: 'progress'; data: { node: string; percent: number } }
  | { type: 'complete'; data: { code: GeneratedCode; qaScore: number } }
  | { type: 'error'; data: { message: string; node: string } };

