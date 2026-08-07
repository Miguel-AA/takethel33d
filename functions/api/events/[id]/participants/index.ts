// GET /api/events/:id/participants — the same listing, under the name an
// operator would look for.
//
// "Participants of this event" is what the admin UI calls this screen, while
// the resource itself is an ENTRY: a participation, bound to a form version,
// belonging to an identity that exists independently of any event. Both names
// are useful, so both paths exist — but there is ONE implementation behind
// them. A second copy would be a second surface to secure, a second place to
// forget `no-store`, and two answers to one question the first time they drift.
//
// There is deliberately no POST here. Creating a participation is `POST
// .../entries`, because that is what it creates: an entry. A `POST
// .../participants` would read as "create a person", which is not something
// this system does.

export { onRequestGet } from '../entries/index';
