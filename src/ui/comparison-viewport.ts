export type ComparisonFrame=Readonly<{width:number;height:number}>;
export type ComparisonView=Readonly<{zoom:number;x:number;y:number}>;
export type ComparisonRect=Readonly<{x:number;y:number;width:number;height:number}>;
export const COMPARISON_ZOOM_LIMITS=Object.freeze({minimum:25,maximum:1600});

export function comparisonFrame(width:number,height:number):ComparisonFrame {
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>8192||height>8192)throw Error('Comparison dimensions are unavailable.');
 return {width,height};
}

/** Percent magnification relative to the same fitted original-coordinate grid.
 * This changes display coordinates only; it never resizes retained pixels. */
export function comparisonRect(frame:ComparisonFrame,view:ComparisonView):ComparisonRect {
 comparisonFrame(frame.width,frame.height);
 if(![view.zoom,view.x,view.y].every(Number.isFinite)||view.zoom<COMPARISON_ZOOM_LIMITS.minimum||view.zoom>COMPARISON_ZOOM_LIMITS.maximum||Math.abs(view.x)>frame.width||Math.abs(view.y)>frame.height)throw Error('Comparison viewport is outside its displayed bounds.');
 const width=frame.width*100/view.zoom,height=frame.height*100/view.zoom;
 return {x:(frame.width-width)/2+view.x,y:(frame.height-height)/2+view.y,width,height};
}

export function comparisonViewBox(frame:ComparisonFrame,view:ComparisonView){const rect=comparisonRect(frame,view);return [rect.x,rect.y,rect.width,rect.height].join(' ');}

export function parseComparisonView(frame:ComparisonFrame,fields:{zoom:string;x:string;y:string}):ComparisonView {
 for(const value of [fields.zoom,fields.x,fields.y])if(value.length>32||!value.trim())throw Error('Enter finite comparison zoom and offsets.');
 const result={zoom:Number(fields.zoom),x:Number(fields.x),y:Number(fields.y)};
 comparisonRect(frame,result);return result;
}

export function comparisonPan(frame:ComparisonFrame,view:ComparisonView,direction:'left'|'right'|'up'|'down'):ComparisonView {
 const rect=comparisonRect(frame,view),step=direction==='left'||direction==='right'?rect.width/10:rect.height/10;
 const result={...view};
 if(direction==='left')result.x-=step;else if(direction==='right')result.x+=step;else if(direction==='up')result.y-=step;else result.y+=step;
 comparisonRect(frame,result);return result;
}
