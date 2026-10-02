import type {RequestReview} from '../../src/request/review.js';
import {baseRequestReview,validateRequestReviewV45Identity} from '../../src/request/review.js';
import {routes} from '../../src/request/core.js';
import type {Operation} from '../../src/request/core.js';
import type {ResponseDescriptor} from './response-adapter.js';
import {refuse} from './contracts.js';

/** Profile selection follows the immutable review, including its admission hash.
 * This structural selector reads no prompt bytes and supplies no dispatch authority.
 * Writer, queue and portable admission require verifyRequestReviewV45 separately.
 * A selected V45 profile remains withholding-only; returned fields cannot select it. */
export function reviewedResponseProfile(input:RequestReview):ResponseDescriptor {
  const review=baseRequestReview(input);
  if(review.kind==='request-review-v45-1'){
    validateRequestReviewV45Identity(review);
    return {profile:review.providerReview.resultContract,endpoint:review.endpoint};
  }
  if(review.kind!=='request-review-1'||!Object.hasOwn(routes,review.request.kind)||routes[review.request.kind as Operation].endpoint!==review.endpoint)refuse('IDENTITY');
  return {profile:'ideogram-v4-result-1',endpoint:review.endpoint};
}
