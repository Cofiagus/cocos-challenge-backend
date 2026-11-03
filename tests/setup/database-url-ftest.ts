// La suite funcional de UC-3 (tests/functional/orders/**, Célula D) usa
// cocos_challenge_ftest para TODO: su pool de asserts (hardcodeado) Y la
// serverApp que importa. No setea process.env.DATABASE_URL (GATE 3 la corre
// SIN modificarla), así que el default del proyecto la apunta a su DB.
// El resto de las suites se autogestiona: smoke carga .env.test, B carga
// .env.test en su support, C y E setean su propia URL antes de componer.
//
// Asignación INCONDICIONAL (no ??=): jest reusa el worker entre archivos y
// dotenv NO pisa una variable ya presente, así que si otra suite ya seteó
// DATABASE_URL en ese worker, ??= heredaría esa URL y serverApp apuntaría
// a otra DB que sus fixtures (rojos/verdes según el scheduling). El
// proyecto uc3-functional es el dueño exclusivo de esta URL.
process.env["DATABASE_URL"] =
  "postgresql://postgres@localhost:5433/cocos_challenge_ftest";