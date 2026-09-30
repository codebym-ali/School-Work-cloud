'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { apiGet, type Klass, type Section } from '@sw/api-client';
import { StudentProfile } from '../student-profile';

export default function StudentProfilePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [classes, setClasses] = useState<Klass[]>([]);
  const [sections, setSections] = useState<Section[]>([]);

  useEffect(() => {
    apiGet<Klass[]>('/classes').then(setClasses).catch(() => {});
    apiGet<Section[]>('/sections').then(setSections).catch(() => {});
  }, []);

  return <StudentProfile id={id} classes={classes} sections={sections} onBack={() => router.back()} />;
}
