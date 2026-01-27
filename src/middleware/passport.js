const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const argon2 = require('argon2');
const prisma = require('../db/prismaClient');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
if (!ACCESS_SECRET) throw new Error('Missing JWT_ACCESS_SECRET env variable');

function initializePassport() {
  // Local strategy
  passport.use(new LocalStrategy(
    { usernameField: 'email', passwordField: 'password', session: false },
    async (email, password, done) => {
      try {
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return done(null, false, { message: 'Invalid credentials' });
        if (!user.passwordHash) return done(null, false, { message: 'Invalid credentials' });

        const ok = await argon2.verify(user.passwordHash, password);
        if (!ok) return done(null, false, { message: 'Invalid credentials' });

        // remove sensitive fields before returning
        const safeUser = { ...user };
        delete safeUser.passwordHash;
        return done(null, safeUser);
      } catch (err) {
        return done(err);
      }
    }
  ));

  // JWT strategy
  passport.use(new JwtStrategy({
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: ACCESS_SECRET,
    passReqToCallback: false,
  }, async (payload, done) => {
    try {
      const userId = payload && payload.sub;
      if (!userId) return done(null, false);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return done(null, false);
      const safeUser = { ...user };
      delete safeUser.passwordHash;
      return done(null, safeUser);
    } catch (err) {
      return done(err);
    }
  }));

  return passport;
}

module.exports = {
  initializePassport,
  passport,
};
