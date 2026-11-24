CREATE INDEX enroll_email ON enrollments(email);
CREATE TRIGGER delete_profile_data BEFORE DELETE ON profiles
BEGIN
  DELETE FROM hosts WHERE profile = OLD.id;
  DELETE FROM devices WHERE profile = OLD.id;
  DELETE FROM enrollments WHERE profile = OLD.id OR email = OLD.email;
END;
