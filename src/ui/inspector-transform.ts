import type {Affine} from '../raster/core.js';
export type TransformValues={a:string;b:string;c:string;d:string;x:string;y:string};
export type FriendlyTransformValues={width:string;height:string;rotation:string};
export type IntrinsicExtent={width:number;height:number};
export const FRIENDLY_NUMERIC_UNITS=128;
export const FRIENDLY_TRANSFORM_HELP='Width and height measure the transformed layer edges in document pixels, not the enclosing box. Rotation is clockwise around the layer origin (X/Y). Shear and reflection are preserved. Scaling text does not reflow its frame.';
const numeric=(value:string,label:string)=>{if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())||value.length>FRIENDLY_NUMERIC_UNITS||!Number.isFinite(Number(value)))throw Error('Enter a finite '+label+'.');return Number(value);};
const angle=(value:number)=>{const remainder=value%360,result=remainder>=180?remainder-360:remainder< -180?remainder+360:remainder;return Object.is(result,-0)?0:result;};
/** Match the renderer's finite determinant/inverse gate, without changing its
 * sealed arithmetic or silently repairing a singular user-entered matrix. */
function validate(matrix:Affine):Affine{const [a,b,c,d,x,y]=matrix,det=a*d-b*c;if(!matrix.every(Number.isFinite)||!Number.isFinite(det)||det===0||![d/det,-b/det,-c/det,a/det,(c*y-d*x)/det,(b*x-a*y)/det].every(Number.isFinite))throw Error('Enter a finite, invertible layer transform.');return matrix;}
export function inspectorMatrix(values:TransformValues):Affine{return validate([numeric(values.a,'A coefficient'),numeric(values.b,'B coefficient'),numeric(values.c,'C coefficient'),numeric(values.d,'D coefficient'),numeric(values.x,'X position'),numeric(values.y,'Y position')]);}
export function validateIntrinsicExtent(extent:IntrinsicExtent){if(!Number.isSafeInteger(extent.width)||!Number.isSafeInteger(extent.height)||extent.width<1||extent.height<1||extent.width>8192||extent.height>8192||extent.width*extent.height>25000000)throw Error('Layer dimensions are unavailable. Use the advanced matrix controls.');}
export function friendlyTransform(values:TransformValues,extent:IntrinsicExtent):FriendlyTransformValues{validateIntrinsicExtent(extent);const m=inspectorMatrix(values),width=Math.hypot(m[0],m[1])*extent.width,height=Math.hypot(m[2],m[3])*extent.height;if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw Error('Layer edge dimensions are outside the supported numeric range.');return {width:String(width),height:String(height),rotation:String(angle(Math.atan2(m[1],m[0])*180/Math.PI))};}
export function changedFriendlyTransform(values:TransformValues,extent:IntrinsicExtent,desired:FriendlyTransformValues):Affine{
 const current=friendlyTransform(values,extent),matrix=inspectorMatrix(values),width=numeric(desired.width,'positive width'),height=numeric(desired.height,'positive height'),degrees=angle(numeric(desired.rotation,'rotation in degrees'));
 if(width<=0||height<=0)throw Error('Layer width and height must be greater than zero.');
 const sx=width/Number(current.width),sy=height/Number(current.height);let a=matrix[0]*sx,b=matrix[1]*sx,c=matrix[2]*sy,d=matrix[3]*sy;
 // Avoid a trigonometric round-trip for an unchanged angle or whole turns.
 if(degrees!==Number(current.rotation)){const radians=angle(degrees-Number(current.rotation))*Math.PI/180,cos=Math.cos(radians),sin=Math.sin(radians),u=a,v=b;a=cos*u-sin*v;b=sin*u+cos*v;const w=c,z=d;c=cos*w-sin*z;d=sin*w+cos*z;}
 return validate([a,b,c,d,matrix[4],matrix[5]]);
}
export function matrixValues(matrix:Affine):TransformValues{return {a:String(matrix[0]),b:String(matrix[1]),c:String(matrix[2]),d:String(matrix[3]),x:String(matrix[4]),y:String(matrix[5])};}
